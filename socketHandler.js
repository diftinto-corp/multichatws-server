// socketHandler.js

class SocketHandler {
  constructor(io, whatsAppClient) {
    this.io = io;
    this.whatsAppClient = whatsAppClient;
    this.processingConversations = new Set(); // Para controlar conversaciones en proceso
  }

  initialize() {
    this.io.on("connection", (socket) => {
      console.log("Agent connected:", socket.id);

      // Manejar cuando un agente toma una conversación
      socket.on("take_conversation", async ({ conversationId }) => {
        // Verificar si la conversación ya está siendo procesada
        if (this.processingConversations.has(conversationId)) {
          console.log(
            `Conversación ${conversationId} ya está siendo procesada`
          );
          return;
        }

        // Marcar la conversación como en proceso
        this.processingConversations.add(conversationId);

        try {
          console.log(
            `Agent ${socket.id} taking conversation ${conversationId}`
          );
          await this.handleTakeConversation(socket, conversationId);
        } finally {
          // Remover la conversación del conjunto de procesamiento
          this.processingConversations.delete(conversationId);
        }
      });

      // Cambiar "send_message" a "agent_message" para coincidir con el cliente
      socket.on("agent_message", async (data) => {
        const { conversationId, message } = data;
        console.log(
          `Agent ${socket.id} sending message to ${conversationId}:`,
          message
        );

        try {
          await this.whatsAppClient.sendMessage(conversationId, message);

          // Enviar confirmación al agente
          socket.emit("message_sent_confirmation", {
            success: true,
            conversationId,
            message,
          });
        } catch (error) {
          console.error("Error sending message:", error);
          socket.emit("message_sent_confirmation", {
            success: false,
            error: error.message,
          });
        }
      });

      socket.on("close_conversation", ({ conversationId }) => {
        this.handleCloseConversation(socket, conversationId);
      });

      socket.on("disconnect", () => {
        console.log("Agent disconnected:", socket.id);
      });
    });
  }

  async handleTakeConversation(socket, conversationId) {
    try {
      // Verificar si la conversación ya tiene un agente asignado
      if (this.whatsAppClient.hasActiveAgent(conversationId)) {
        console.log(
          `Conversación ${conversationId} ya tiene un agente asignado`
        );
        return;
      }

      // Unir al socket a una sala específica para esta conversación
      socket.join(conversationId);

      // Asignar el agente a la conversación
      this.whatsAppClient.assignAgent(conversationId, socket.id);

      // Obtener historial de mensajes
      const messageHistory = await this.whatsAppClient.getMessageHistory(
        conversationId
      );

      // Enviar historial al agente
      socket.emit("conversation-history", {
        conversationId,
        messages: messageHistory,
      });

      // Notificar que la conversación fue tomada
      socket.broadcast.emit("conversation_taken", {
        conversationId,
        agentId: socket.id,
      });

      // Enviar mensaje al usuario
      await this.whatsAppClient.sendMessage(
        conversationId,
        "Le he informado a un agente humano, dentro de poco te escribirá, hasta luego"
      );

      console.log(`Conversación ${conversationId} iniciada exitosamente`);
    } catch (error) {
      console.error("Error al manejar toma de conversación:", error);
      socket.emit("error", {
        message: "Error al procesar la solicitud",
        details: error.message,
      });
    }
  }

  handleCloseConversation(socket, conversationId) {
    this.whatsAppClient.closeConversation(conversationId);
    this.io.emit("conversation_closed", { conversationId });
    console.log(`Conversation ${conversationId} closed by agent ${socket.id}`);
  }
}

module.exports = SocketHandler;
