// whatsappClient.js
// Importamos las librerías necesarias para el funcionamiento del cliente de WhatsApp
const { Boom } = require("@hapi/boom"); // Para manejar errores específicos
const makeWASocket = require("@whiskeysockets/baileys").default; // Cliente de WhatsApp
// Importamos varias utilidades de Baileys para manejar el estado de autenticación, la versión de WhatsApp, y más
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  proto,
  makeInMemoryStore,
} = require("@whiskeysockets/baileys");
const P = require("pino"); // Librería de logging
const generateAIResponse = require("./openai"); // Función para generar respuestas automáticas

// Configuramos el logger para registrar eventos y errores
const logger = P(
  { timestamp: () => `,"time":"${new Date().toJSON()}"` },
  P.destination("./wa-logs.txt")
);
logger.level = "trace"; // Establecemos el nivel de detalle de los logs

// Definimos la clase WhatsAppClient para manejar la conexión y la lógica del bot
class WhatsAppClient {
  constructor(io) {
    this.io = io; // Socket.io para comunicación en tiempo real con el frontend
    this.sock = null; // Inicializamos el socket de WhatsApp como nulo
    this.activeConversations = {}; // Objeto para almacenar las conversaciones activas

    // Configurar el store
    this.store = makeInMemoryStore({});
    this.store.readFromFile("./baileys_store.json");

    // Guardar el store cada 10000 ms
    setInterval(() => {
      this.store.writeToFile("./baileys_store.json");
    }, 10000);
  }

  // Método para formatear números de teléfono al formato requerido por WhatsApp
  formatWhatsAppNumber(number) {
    const cleaned = number.replace(/\D/g, ""); // Eliminamos caracteres no numéricos
    return `${cleaned}@s.whatsapp.net`; // Añadimos el dominio de WhatsApp
  }

  // Método para iniciar la conexión con el servidor de WhatsApp
  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(
      "baileys_auth_info"
    ); // Cargamos o inicializamos el estado de autenticación
    const { version, isLatest } = await fetchLatestBaileysVersion(); // Obtenemos la última versión de WhatsApp
    console.log(`Using WA version ${version.join(".")}, isLatest: ${isLatest}`);

    // Creamos el socket de WhatsApp con la configuración necesaria
    this.sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: true, // Imprime el QR en la terminal para la autenticación
      auth: {
        creds: state.creds, // Credenciales de autenticación
        keys: makeCacheableSignalKeyStore(state.keys, logger), // Almacenamiento de claves
      },
      generateHighQualityLinkPreview: true, // Genera vistas previas de enlaces de alta calidad
      // Configuraciones adicionales para la conexión
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 5000,
    });

    // Bind el store al socket
    this.store.bind(this.sock.ev);

    // Procesamos los eventos emitidos por el socket de WhatsApp
    this.sock.ev.process(async (events) => {
      if (events["messages.upsert"]) {
        await this.handleNewMessages(events["messages.upsert"]); // Manejamos nuevos mensajes
      }

      if (events["connection.update"]) {
        await this.handleConnectionUpdate(events["connection.update"]); // Manejamos actualizaciones de conexión
      }

      if (events["creds.update"]) {
        await saveCreds(); // Guardamos las credenciales actualizadas
      }
    });
  }

  // Método para manejar la recepción de nuevos mensajes
  async handleNewMessages(upsert) {
    if (upsert.type === "notify") {
      for (const msg of upsert.messages) {
        const conversationId = msg.key.remoteJid; // ID de la conversación
        console.log("Message details:", JSON.stringify(msg, null, 2)); // Detalles del mensaje

        // Procesamos el mensaje si es de texto
        if (msg.message?.extendedTextMessage || msg.message?.conversation) {
          const text =
            msg.message?.extendedTextMessage?.text || msg.message?.conversation; // Extraemos el texto del mensaje
          console.log(`Received message from ${conversationId}: "${text}"`);

          await this.processMessage(conversationId, text); // Procesamos el mensaje recibido
        }
      }
    }
  }

  // Método para procesar mensajes recibidos
  async processMessage(conversationId, text) {
    const formattedNumber = this.formatWhatsAppNumber(conversationId);
    const agentId = this.activeConversations[formattedNumber];
    console.log(
      `Procesando mensaje para ${formattedNumber}, agentId: ${agentId}`
    );

    if (agentId) {
      console.log(`Reenviando mensaje al agente ${agentId}`);

      this.io.to(agentId).emit("user_message", {
        conversationId: formattedNumber,
        message: text,
      });

      try {
        // Solo marcar como leído, sin cambiar el estado de presencia
        await this.sock.readMessages([
          {
            remoteJid: formattedNumber,
            id: Date.now().toString(),
          },
        ]);

        // Removemos esta línea que actualizaba la presencia
        // await this.sock.sendPresenceUpdate("composing", formattedNumber);

        console.log(`Mensaje reenviado exitosamente al agente ${agentId}`);
      } catch (error) {
        console.error("Error al procesar mensaje:", error);
      }
    } else {
      // Si no hay agente asignado, procesamos el mensaje automáticamente o solicitamos un agente humano
      if (text.toLowerCase().includes("humano")) {
        console.log("Usuario solicitó un agente humano");
        this.io.emit("new_conversation", { conversationId: formattedNumber });
      } else {
        console.log("No hay agente activo, procesando con IA");
        try {
          const aiResponse = await generateAIResponse(text); // Generamos una respuesta automática
          console.log(`Respuesta IA: "${aiResponse}"`);
          await this.sendMessage(formattedNumber, aiResponse); // Enviamos la respuesta
        } catch (error) {
          console.error("Error al procesar respuesta IA:", error);
        }
      }
    }
  }
  // Método para manejar actualizaciones de la conexión
  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect } = update; // Extraemos los detalles de la actualización

    if (connection === "close") {
      // Si la conexión se cerró, intentamos reconectar según el motivo del cierre
      console.log("Connection closed:", lastDisconnect?.error);
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom &&
        lastDisconnect.error.output?.statusCode !==
          DisconnectReason.loggedOut &&
        lastDisconnect.error.output?.statusCode !== 440;

      if (shouldReconnect) {
        console.log("Attempting to reconnect...");
        this.start(); // Intentamos reconectar
      } else {
        console.log(
          "You are logged out or there is a conflict. Resolve the issue and restart the server."
        );
      }
    } else if (connection === "open") {
      console.log("Connection opened."); // La conexión se abrió correctamente
    }
  }

  // Método para enviar un mensaje
  async sendMessage(conversationId, message) {
    const formattedNumber = this.formatWhatsAppNumber(conversationId);
    const maxRetries = 3;
    let retryCount = 0;

    const trySendMessage = async () => {
      try {
        // Ya no enviamos el estado "composing" aquí
        const result = await this.sock.sendMessage(formattedNumber, {
          text: message,
        });

        // Establecer como disponible después de enviar
        await this.sock.sendPresenceUpdate("available", formattedNumber);

        console.log(`Mensaje enviado a ${formattedNumber} exitosamente`);
        return result;
      } catch (error) {
        console.error(`Intento ${retryCount + 1} fallido:`, error);
        if (retryCount < maxRetries) {
          retryCount++;
          console.log(`Reintentando envío (${retryCount}/${maxRetries})...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return trySendMessage();
        }
        throw error;
      }
    };

    return trySendMessage();
  }

  // Método para verificar si hay un agente activo en la conversación
  hasActiveAgent(conversationId) {
    const formattedNumber = this.formatWhatsAppNumber(conversationId); // Formateamos el número
    return Boolean(this.activeConversations[formattedNumber]); // Devolvemos true si hay un agente asignado
  }

  // Método para asignar un agente a una conversación
  assignAgent(conversationId, agentId) {
    const formattedNumber = this.formatWhatsAppNumber(conversationId); // Formateamos el número
    if (this.activeConversations[formattedNumber]) {
      // Verificamos si ya hay un agente asignado
      console.log(
        `Conversación ${formattedNumber} ya tiene un agente asignado`
      );
      return false; // No asignamos el agente si ya hay uno
    }
    this.activeConversations[formattedNumber] = agentId; // Asignamos el agente a la conversación
    console.log(`Agente ${agentId} asignado a conversación ${formattedNumber}`);
    return true; // Devolvemos true para indicar que el agente fue asignado
  }

  // Método para cerrar una conversación
  closeConversation(conversationId) {
    const formattedNumber = this.formatWhatsAppNumber(conversationId); // Formateamos el número
    delete this.activeConversations[formattedNumber]; // Eliminamos la conversación de las activas
  }

  // Método para obtener el historial de mensajes de una conversación
  async getMessageHistory(conversationId) {
    const formattedNumber = this.formatWhatsAppNumber(conversationId);
    try {
      console.log(`Obteniendo historial para ${formattedNumber}`);

      // Obtener los últimos mensajes
      const messages = await this.store.loadMessages(formattedNumber, 100);
      console.log("Mensajes cargados del store:", messages?.length || 0);

      if (messages && messages.length > 0) {
        await this.sock.readMessages([
          {
            remoteJid: formattedNumber,
            id: messages[messages.length - 1]?.key?.id,
            participant: undefined,
          },
        ]);
      }

      // Formatear los mensajes
      const formattedMessages =
        messages?.map((msg) => {
          const content = this.extractMessageContent(msg);
          const fromMe = msg.key.fromMe;
          const messageInfo = {
            id: msg.key.id || Date.now().toString(),
            sender: fromMe ? "ai" : "user",
            timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
            content: content,
          };
          console.log("Mensaje formateado:", messageInfo);
          return messageInfo;
        }) || [];

      console.log(`Total de mensajes formateados: ${formattedMessages.length}`);
      return formattedMessages;
    } catch (error) {
      console.error("Error al obtener historial de mensajes:", error);
      return [];
    }
  }

  // Método auxiliar para formatear mensajes
  formatMessages(messages) {
    return messages.map((msg) => ({
      id: msg.key.id || Date.now().toString(), // Usamos el ID del mensaje o generamos uno
      sender: msg.key.fromMe ? "bot" : "user", // Determinamos el remitente
      timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000), // Usamos el timestamp del mensaje o generamos uno
      content: this.extractMessageContent(msg), // Extraemos el contenido del mensaje
    }));
  }

  // Método auxiliar para extraer el contenido del mensaje
  extractMessageContent(msg) {
    if (!msg.message) {
      console.log("Mensaje sin contenido");
      return "Mensaje no disponible";
    }

    // Extraer el contenido del mensaje
    const content =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.buttonsResponseMessage?.selectedDisplayText ||
      msg.message.templateButtonReplyMessage?.selectedDisplayText;

    if (!content) {
      console.log("Tipo de mensaje no soportado:", Object.keys(msg.message));
      return "Contenido no soportado";
    }

    console.log("Contenido extraído:", content);
    return content;
  }
}

module.exports = WhatsAppClient; // Exportamos la clase para su uso en otros archivos
