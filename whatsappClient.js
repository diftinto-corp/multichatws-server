// whatsappClient.js
const { Boom } = require("@hapi/boom");
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  proto,
  makeInMemoryStore,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const generateAIResponse = require("./openai");

// Configuración del logger
const logger = P(
  { timestamp: () => `,"time":"${new Date().toJSON()}"` },
  P.destination("./wa-logs.txt")
);
logger.level = "trace";

class WhatsAppClient {
  constructor(io) {
    this.io = io;
    this.sock = null;
    this.activeConversations = {};
    this.store = makeInMemoryStore({});
  }

  // Agregar la función de formateo como método de la clase
  formatWhatsAppNumber(number) {
    // Eliminar cualquier caracter que no sea número
    const cleaned = number.replace(/\D/g, "");
    // Asegurarse de que tenga el formato correcto para WhatsApp
    return `${cleaned}@s.whatsapp.net`;
  }

  // Método para iniciar el cliente de WhatsApp
  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(
      "baileys_auth_info"
    );
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA version ${version.join(".")}, isLatest: ${isLatest}`);

    this.sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      generateHighQualityLinkPreview: true,
      // Agregar estas configuraciones
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 5000,
    });

    // Procesar los eventos de WhatsApp
    this.sock.ev.process(async (events) => {
      if (events["messages.upsert"]) {
        await this.handleNewMessages(events["messages.upsert"]);
      }

      if (events["connection.update"]) {
        await this.handleConnectionUpdate(events["connection.update"]);
      }

      if (events["creds.update"]) {
        await saveCreds();
      }
    });
  }

  // Método para manejar nuevos mensajes
  async handleNewMessages(upsert) {
    if (upsert.type === "notify") {
      for (const msg of upsert.messages) {
        const conversationId = msg.key.remoteJid;
        console.log("Message details:", JSON.stringify(msg, null, 2));

        if (msg.message?.extendedTextMessage || msg.message?.conversation) {
          const text =
            msg.message?.extendedTextMessage?.text || msg.message?.conversation;
          console.log(`Received message from ${conversationId}: "${text}"`);

          await this.processMessage(conversationId, text);
        }
      }
    }
  }

  // Método para procesar mensajes
  async processMessage(conversationId, text) {
    const formattedNumber = this.formatWhatsAppNumber(conversationId);
    const agentId = this.activeConversations[formattedNumber];
    console.log(
      `Procesando mensaje para ${formattedNumber}, agentId: ${agentId}`
    );

    if (agentId) {
      console.log(`Reenviando mensaje al agente ${agentId}`);

      // Modificar la estructura del mensaje enviado al agente
      this.io.to(agentId).emit("user_message", {
        conversationId: formattedNumber,
        message: text, // Enviar solo el texto del mensaje
      });

      try {
        await this.sock.readMessages([
          {
            remoteJid: formattedNumber,
            id: Date.now().toString(),
          },
        ]);

        await this.sock.sendPresenceUpdate("composing", formattedNumber);

        console.log(`Mensaje reenviado exitosamente al agente ${agentId}`);
      } catch (error) {
        console.error("Error al procesar mensaje:", error);
      }
    } else {
      if (text.toLowerCase().includes("humano")) {
        console.log("Usuario solicitó un agente humano");
        this.io.emit("new_conversation", { conversationId: formattedNumber });
      } else {
        console.log("No hay agente activo, procesando con IA");
        try {
          const aiResponse = await generateAIResponse(text);
          console.log(`Respuesta IA: "${aiResponse}"`);
          await this.sendMessage(formattedNumber, aiResponse);
        } catch (error) {
          console.error("Error al procesar respuesta IA:", error);
        }
      }
    }
  }

  // Método para manejar actualizaciones de conexión
  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      console.log("Connection closed:", lastDisconnect?.error);
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom &&
        lastDisconnect.error.output?.statusCode !==
          DisconnectReason.loggedOut &&
        lastDisconnect.error.output?.statusCode !== 440;

      if (shouldReconnect) {
        console.log("Attempting to reconnect...");
        this.start();
      } else {
        console.log(
          "You are logged out or there is a conflict. Resolve the issue and restart the server."
        );
      }
    } else if (connection === "open") {
      console.log("Connection opened.");
    }
  }

  // Método para enviar un mensaje
  async sendMessage(conversationId, message) {
    const formattedNumber = this.formatWhatsAppNumber(conversationId);
    const maxRetries = 3;
    let retryCount = 0;

    const trySendMessage = async () => {
      try {
        await this.sock.sendPresenceUpdate("composing", formattedNumber);

        const result = await this.sock.sendMessage(formattedNumber, {
          text: message,
        });

        await this.sock.sendPresenceUpdate("available", formattedNumber);
        console.log(`Mensaje enviado a ${formattedNumber} exitosamente`);
        return result;
      } catch (error) {
        console.error(`Intento ${retryCount + 1} fallido:`, error);
        if (retryCount < maxRetries) {
          retryCount++;
          console.log(`Reintentando envío (${retryCount}/${maxRetries})...`);
          await new Promise((resolve) => setTimeout(resolve, 2000)); // Esperar 2 segundos
          return trySendMessage();
        }
        throw error;
      }
    };

    return trySendMessage();
  }

  // Método para asignar un agente a una conversación
  assignAgent(conversationId, agentId) {
    const formattedNumber = this.formatWhatsAppNumber(conversationId);
    this.activeConversations[formattedNumber] = agentId;
  }

  // Método para cerrar una conversación
  closeConversation(conversationId) {
    const formattedNumber = this.formatWhatsAppNumber(conversationId);
    delete this.activeConversations[formattedNumber];
  }

  // Método para obtener el historial de mensajes
  async getMessageHistory(conversationId) {
    const formattedNumber = this.formatWhatsAppNumber(conversationId);
    try {
      const messages = await this.store.loadMessages(formattedNumber, 50);

      await this.sock.readMessages([
        {
          remoteJid: formattedNumber,
          id: messages[messages.length - 1]?.key?.id,
          participant: undefined,
        },
      ]);

      await this.sock.sendPresenceUpdate("available", formattedNumber);

      return this.formatMessages(messages || []);
    } catch (error) {
      console.error("Error al obtener historial de mensajes:", error);
      return [];
    }
  }

  // Método auxiliar para formatear mensajes
  formatMessages(messages) {
    return messages.map((msg) => ({
      id: msg.key.id || Date.now().toString(),
      sender: msg.key.fromMe ? "bot" : "user",
      timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
      content: this.extractMessageContent(msg),
    }));
  }

  // Método auxiliar para extraer el contenido del mensaje
  extractMessageContent(msg) {
    if (!msg.message) return "Mensaje no disponible";

    return (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.buttonsResponseMessage?.selectedDisplayText ||
      msg.message.templateButtonReplyMessage?.selectedDisplayText ||
      "Contenido no soportado"
    );
  }
}

module.exports = WhatsAppClient;
