// openai.js
const OpenAI = require("openai");

// Configurar OpenAI con la API Key desde las variables de entorno
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Función para generar respuesta utilizando la API de OpenAI
const generateAIResponse = async (message) => {
  try {
    console.log(`Generating AI response for message: "${message}"`);
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // O 'gpt-4' si tienes acceso
      messages: [{ role: "user", content: message }],
    });
    const aiMessage = response.choices[0].message.content;
    console.log(`AI Response: "${aiMessage}"`);
    return aiMessage;
  } catch (error) {
    console.error("Error with OpenAI API:", error);
    return "Sorry, I am having trouble processing your request. Please try again later.";
  }
};

module.exports = generateAIResponse; // Exportar la función directamente
