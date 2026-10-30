export const ANTIGRAVITY_SDK_SIDECAR = String.raw`
import asyncio
import json
import sys
import uuid
from importlib import metadata

protocol_out = sys.stdout
sys.stdout = sys.stderr

from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig
from google.antigravity.hooks import policy

SUPPORTED_SDK = "0.1.22"
try:
    installed_sdk = metadata.version("google-antigravity")
except metadata.PackageNotFoundError:
    installed_sdk = SUPPORTED_SDK
if installed_sdk != SUPPORTED_SDK:
    raise RuntimeError(f"Maestro requires google-antigravity=={SUPPORTED_SDK}, found {installed_sdk}")


def emit(frame):
    protocol_out.write(json.dumps(frame, separators=(",", ":")) + "\n")
    protocol_out.flush()


class Bridge:
    def __init__(self):
        self.agent = None
        self.turn = None
        self.pending = {}
        self.running = True

    async def approval(self, tool_call):
        request_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.pending[request_id] = future
        emit({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "approval",
            "params": {
                "request_id": request_id,
                "tool": getattr(tool_call, "name", "tool"),
                "input": getattr(tool_call, "parameters", None) or getattr(tool_call, "arguments", {}) or {},
            },
        })
        try:
            return bool(await future)
        finally:
            self.pending.pop(request_id, None)

    async def run_turn(self, prompt):
        code = 0
        try:
            response = await self.agent.chat(prompt)
            text = await response.text()
            if text:
                emit({"jsonrpc": "2.0", "method": "text", "params": {"text": text}})
        except asyncio.CancelledError:
            code = 0
        except Exception as error:
            code = 1
            emit({"jsonrpc": "2.0", "method": "error", "params": {"message": str(error)}})
        emit({"jsonrpc": "2.0", "method": "complete", "params": {"code": code}})

    async def start(self, params):
        mode = params.get("permission_mode", "standard")
        if mode == "full":
            policies = [policy.allow("*")]
        else:
            policies = policy.safe_defaults(handler=self.approval if mode == "standard" else self.deny)
        kwargs = {
            "workspaces": [params["cwd"]],
            "policies": policies,
        }
        if mode != "readonly":
            kwargs["capabilities"] = CapabilitiesConfig()
        if params.get("model"):
            kwargs["model"] = params["model"]
        self.agent = Agent(LocalAgentConfig(**kwargs))
        await self.agent.__aenter__()
        self.turn = asyncio.create_task(self.run_turn(params.get("prompt", "")))
        return {"started": True}

    async def deny(self, _tool_call):
        return False

    async def interrupt(self):
        if self.turn and not self.turn.done():
            self.turn.cancel()
        return {"interrupted": True}

    async def close(self):
        self.running = False
        await self.interrupt()
        if self.agent:
            await self.agent.__aexit__(None, None, None)
            self.agent = None
        for future in self.pending.values():
            if not future.done():
                future.set_result(False)
        return {"closed": True}

    async def dispatch(self, frame):
        method = frame.get("method")
        request_id = frame.get("id")
        if not method and request_id in self.pending:
            future = self.pending.get(request_id)
            result = frame.get("result") or {}
            if future and not future.done():
                future.set_result(bool(result.get("allow")))
            return
        try:
            if method == "start":
                result = await self.start(frame.get("params") or {})
            elif method == "interrupt":
                result = await self.interrupt()
            elif method == "close":
                result = await self.close()
            else:
                raise ValueError("unknown method: " + str(method))
            emit({"jsonrpc": "2.0", "id": request_id, "result": result})
        except Exception as error:
            emit({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": str(error)}})

    async def main(self):
        while self.running:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                await self.close()
                break
            try:
                frame = json.loads(line)
                await self.dispatch(frame)
            except Exception as error:
                emit({"jsonrpc": "2.0", "method": "error", "params": {"message": str(error)}})


asyncio.run(Bridge().main())
`;
