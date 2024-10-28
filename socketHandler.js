// socketHandler.js

// Esta clase maneja las conexiones de socket y las interacciones con el cliente de WhatsApp
class SocketHandler {
  // Constructor de la clase, inicializa el servidor de socket y el cliente de WhatsApp
  constructor(io, whatsAppClient) {
    this.io = io; // Servidor de socket para comunicación en tiempo real
    this.whatsAppClient = whatsAppClient; // Cliente de WhatsApp para enviar y recibir mensajes
    this.processingConversations = new Set(); // Conjunto para controlar las conversaciones en proceso
  }

  // Método para inicializar los manejadores de eventos de socket
  initialize() {
    // Escuchar conexiones entrantes de agentes
    this.io.on("connection", (socket) => {
      console.log("Agent connected:", socket.id); // Log cuando un agente se conecta

      // Evento para manejar la toma de una conversación por un agente
      socket.on("take_conversation", async ({ conversationId }) => {
        // Verificar si la conversación ya está siendo procesada
        if (this.processingConversations.has(conversationId)) {
          console.log(
            `Conversación ${conversationId} ya está siendo procesada`
          );
          return; // Si ya se está procesando, no hacer nada
        }

        // Marcar la conversación como en proceso
        this.processingConversations.add(conversationId);

        try {
          console.log(
            `Agent ${socket.id} taking conversation ${conversationId}`
          );
          // Manejar la toma de la conversación
          await this.handleTakeConversation(socket, conversationId);
        } finally {
          // Remover la conversación del conjunto de procesamiento una vez finalizado
          this.processingConversations.delete(conversationId);
        }
      });

      // Evento para manejar el envío de mensajes por parte del agente
      socket.on("agent_message", async (data) => {
        const { conversationId, message } = data;
        console.log(
          `Agent ${socket.id} sending message to ${conversationId}:`,
          message
        );

        try {
          // Intentar enviar el mensaje a través del cliente de WhatsApp
          await this.whatsAppClient.sendMessage(conversationId, message);

          // Enviar confirmación de envío al agente
          socket.emit("message_sent_confirmation", {
            success: true,
            conversationId,
            message,
          });
        } catch (error) {
          console.error("Error sending message:", error);
          // Enviar confirmación de fallo al agente
          socket.emit("message_sent_confirmation", {
            success: false,
            error: error.message,
          });
        }
      });

      // Evento para manejar el cierre de una conversación por parte del agente
      socket.on("close_conversation", ({ conversationId }) => {
        this.handleCloseConversation(socket, conversationId);
      });

      // Evento para manejar la desconexión de un agente
      socket.on("disconnect", () => {
        console.log("Agent disconnected:", socket.id);
      });
    });
  }

  // Método para manejar la toma de una conversación por un agente
  async handleTakeConversation(socket, conversationId) {
    try {
      // Verificar si la conversación ya tiene un agente asignado
      if (this.whatsAppClient.hasActiveAgent(conversationId)) {
        console.log(
          `Conversación ${conversationId} ya tiene un agente asignado`
        );
        return; // Si ya hay un agente, no hacer nada
      }

      // Unir al socket a una sala específica para esta conversación
      socket.join(conversationId);

      // Asignar el agente a la conversación
      this.whatsAppClient.assignAgent(conversationId, socket.id);

      // Obtener el historial de mensajes de la conversación
      const messageHistory = await this.whatsAppClient.getMessageHistory(
        conversationId
      );

      // Enviar el historial de mensajes al agente
      socket.emit("conversation-history", {
        conversationId,
        messages: messageHistory,
      });

      // Notificar a otros agentes que la conversación fue tomada
      socket.broadcast.emit("conversation_taken", {
        conversationId,
        agentId: socket.id,
      });

      // Enviar mensaje al usuario indicando que un agente humano se unirá pronto
      await this.whatsAppClient.sendMessage(
        conversationId,
        "Le he informado a un agente humano, dentro de poco te escribirá, hasta luego👋"
      );

      console.log(`Conversación ${conversationId} iniciada exitosamente`);
    } catch (error) {
      console.error("Error al manejar toma de conversación:", error);
      // Notificar al agente sobre el error
      socket.emit("error", {
        message: "Error al procesar la solicitud",
        details: error.message,
      });
    }
  }

  // Método para manejar el cierre de una conversación por parte de un agente
  handleCloseConversation(socket, conversationId) {
    // Cerrar la conversación en el cliente de WhatsApp
    this.whatsAppClient.closeConversation(conversationId);
    // Notificar a todos los agentes que la conversación ha sido cerrada
    this.io.emit("conversation_closed", { conversationId });
    console.log(`Conversation ${conversationId} closed by agent ${socket.id}`);
  }
}

module.exports = SocketHandler;
