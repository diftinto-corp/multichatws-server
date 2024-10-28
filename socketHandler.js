// socketHandler.js

class SocketHandler {
  constructor(io, whatsAppClient) {
    this.io = io;
    this.whatsAppClient = whatsAppClient;
  }

  initialize() {
    this.io.on("connection", (socket) => {
      console.log("Agent connected:", socket.id);

      // Manejar cuando un agente toma una conversación
      socket.on("take_conversation", async ({ conversationId }) => {
        console.log(`Agent ${socket.id} taking conversation ${conversationId}`);
        await this.handleTakeConversation(socket, conversationId);
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
      this.io.emit("conversation_taken", {
        conversationId,
        agentId: socket.id,
      });

      // Mensaje automático al usuario
      await this.whatsAppClient.sendMessage(
        conversationId,
        "Ya notifique a un agente para que pueda ayudarte. Hasta luego."
      );
    } catch (error) {
      console.error("Error handling take conversation:", error);
      socket.emit("error", {
        message: "Error al procesar la solicitud",
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
