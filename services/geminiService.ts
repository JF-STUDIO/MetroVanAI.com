
import { GoogleGenAI } from "@google/genai";

export class GeminiService {
  /**
   * Processes a photograph using Gemini AI.
   * Following the latest @google/genai guidelines for image editing.
   */
  async processPhoto(imageBase64: string, prompt: string): Promise<string> {
    // Initializing GoogleGenAI with the API key from process.env.API_KEY as required.
    // Creating the instance inside the call to ensure the most up-to-date key is used.
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    try {
      // Using gemini-2.5-flash-image for general image editing tasks.
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            {
              inlineData: {
                data: imageBase64.split(',')[1],
                mimeType: 'image/png'
              }
            },
            { text: prompt }
          ]
        }
      });

      let editedImageBase64 = '';
      // Iterating through parts to find the image response as per guidelines.
      if (response.candidates?.[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            editedImageBase64 = `data:image/png;base64,${part.inlineData.data}`;
            break;
          }
        }
      }

      if (!editedImageBase64) {
        throw new Error("Model did not return an edited image part. It might have been blocked or no change was generated.");
      }

      return editedImageBase64;
    } catch (error) {
      console.error("Gemini Edit Error:", error);
      throw error;
    }
  }
}

export const geminiService = new GeminiService();
