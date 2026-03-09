# Building and Running on Windows

This guide provides instructions for setting up your environment and running the Maestro application on a Windows machine.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js:** Version 22 or later.
- **Python:** Version 3 or later.

Additionally, you will need the Visual Studio Build Tools to compile native Node.js modules used in this project.

### Installing Visual Studio Build Tools

1.  **Download the Build Tools:**
    - Go to the [Visual Studio Downloads page](https://my.visualstudio.com/Downloads?q=Visual%20Studio%202022).
    - You may need to log in with a Microsoft account.
    - Download the **Build Tools for Visual Studio 2022**.

2.  **Run the Installer:**
    - When the installer launches, you will be prompted to select workloads.
    - Check the box for **Desktop development with C++**.
    - Proceed with the installation.

3.  **Verify the Setup:**
    - After the installation is complete, open a PowerShell terminal in the project root.
    - Run `npm ci` to install dependencies. If you have already run `npm install`, you can run `npx electron-rebuild` to rebuild the native modules.

## Running the Application in Development Mode

There are two ways to run the application in development mode on Windows: using the provided script or by running the steps manually.

### Using the Development Script (Recommended)

The easiest way to start the development environment is to use the `dev:win` npm script. This script automates the entire process.

Open a PowerShell terminal and run:

```powershell
npm run dev:win
```

This will handle all the necessary build steps and launch the application.

### Manual Steps

If you encounter issues with the `dev:win` script or prefer to run the steps manually, follow this procedure.

1.  **Build the application:**

    ```powershell
    npm run build
    ```

2.  **Start the Vite renderer:**

    ```powershell
    npm run dev:renderer
    ```

3.  **Start the Electron main process:**
    Open a **new** PowerShell terminal and run the following command:
    ```powershell
    npx tsc -p tsconfig.main.json; $env:NODE_ENV='development'; npx electron .
    ```

This will launch the application in development mode with hot-reloading for the renderer.
