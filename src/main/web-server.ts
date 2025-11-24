import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { FastifyInstance } from 'fastify';

export class WebServer {
  private server: FastifyInstance;
  private port: number;
  private isRunning: boolean = false;

  constructor(port: number = 8000) {
    this.port = port;
    this.server = Fastify({
      logger: {
        level: 'info',
      },
    });

    this.setupMiddleware();
    this.setupRoutes();
  }

  private async setupMiddleware() {
    // Enable CORS for web access
    await this.server.register(cors, {
      origin: true,
    });

    // Enable WebSocket support
    await this.server.register(websocket);
  }

  private setupRoutes() {
    // Health check
    this.server.get('/health', async () => {
      return { status: 'ok', timestamp: Date.now() };
    });

    // WebSocket endpoint for real-time updates
    this.server.get('/ws', { websocket: true }, (connection) => {
      connection.socket.on('message', (message) => {
        // Echo back for now - will implement proper session handling
        connection.socket.send(JSON.stringify({
          type: 'echo',
          data: message.toString(),
        }));
      });

      connection.socket.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to Maestro WebSocket',
      }));
    });

    // Session list endpoint
    this.server.get('/api/sessions', async () => {
      return {
        sessions: [],
        timestamp: Date.now(),
      };
    });

    // Session detail endpoint
    this.server.get('/api/sessions/:id', async (request) => {
      const { id } = request.params as { id: string };
      return {
        sessionId: id,
        status: 'idle',
      };
    });
  }

  async start() {
    if (this.isRunning) {
      console.log('Web server already running');
      return;
    }

    try {
      await this.server.listen({ port: this.port, host: '0.0.0.0' });
      this.isRunning = true;
      console.log(`Maestro web server running on http://localhost:${this.port}`);
    } catch (error) {
      console.error('Failed to start web server:', error);
      throw error;
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    try {
      await this.server.close();
      this.isRunning = false;
      console.log('Web server stopped');
    } catch (error) {
      console.error('Failed to stop web server:', error);
    }
  }

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }

  getServer(): FastifyInstance {
    return this.server;
  }
}
