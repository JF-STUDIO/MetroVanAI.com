
import { geminiService } from './geminiService';
import { runningHubService } from './runningHubService';
import { PhotoTool } from '../types';

export class PhotoService {
  async process(imageBase64: string, tool: PhotoTool): Promise<string> {
    if (tool.apiProvider === 'runninghub') {
      return await runningHubService.processPhoto(imageBase64, tool);
    } else {
      // Default to Gemini
      return await geminiService.processPhoto(imageBase64, tool.promptTemplate);
    }
  }
}

export const photoService = new PhotoService();