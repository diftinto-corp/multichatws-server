// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const WhatsAppClient = require("./whatsappClient");
const SocketHandler = require("./socketHandler");

// Configuración de Express y Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000", // Cambia esto según la URL de tu cliente Next.js
    methods: ["GET", "POST"],
  },
});

// Inicializar el cliente de WhatsApp
const whatsAppClient = new WhatsAppClient(io);

// Inicializar el manejador de Socket.IO
const socketHandler = new SocketHandler(io, whatsAppClient);

// Iniciar el servidor con reintentos
const startServer = async () => {
  const maxRetries = 3;
  let retryCount = 0;

  const tryConnect = async () => {
    try {
      await whatsAppClient.start();
      socketHandler.initialize();

      server.listen(3002, () => {
        console.log("Socket.IO server running on http://localhost:3002");
      });
    } catch (error) {
      console.error("Error al iniciar el servidor:", error.message);

      if (retryCount < maxRetries) {
        retryCount++;
        console.log(
          `Reintentando conexión (intento ${retryCount}/${maxRetries})...`
        );
        // Esperar 5 segundos antes de reintentar
        setTimeout(tryConnect, 5000);
      } else {
        console.error(
          "Número máximo de intentos alcanzado. Por favor, verifica tu conexión y credenciales."
        );
        process.exit(1);
      }
    }
  };

  await tryConnect();
};

startServer();
