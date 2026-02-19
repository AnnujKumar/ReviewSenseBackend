import 'dotenv/config';
import { GoogleGenAI } from "@google/genai";

// Initialize the client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// UPDATED: Switching to Gemma 3 12B (Instruction Tuned)
// This is the open-weights model which is often cheaper or free for testing
const modelName = "gemma-3-12b-it"; 

export { ai, modelName };