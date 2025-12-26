
import { PhotoTool } from '../types';

export class RunningHubService {
  // 采用 Python 脚本中的国际版域名
  private readonly BASE_URL = 'https://api.runninghub.ai';

  /**
   * 按照 Python 脚本的思路处理照片
   * 
   * 注意：浏览器端的 fetch 会受 CORS (跨域资源共享) 限制。
   * 如果 api.runninghub.ai 服务器没有配置 Access-Control-Allow-Origin: *，
   * 浏览器会抛出 "Failed to fetch" 错误。
   */
  async processPhoto(imageBase64: string, tool: PhotoTool): Promise<string> {
    const apiKey = (tool.externalApiKey || '').trim();
    const workflowId = (tool.workflowId || '').trim();
    const inputKey = (tool.inputNodeKey || 'input_image').trim();

    if (!apiKey) {
      throw new Error('RunningHub API Key is missing.');
    }

    try {
      // 提取 base64 原始数据
      const rawBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

      // 构造请求体，完全匹配 Python 脚本的结构
      const payload: any = {
        apiKey: apiKey,
        workflowId: workflowId,
      };

      // 增加图片输入。虽然 Python 脚本示例没写图片，但在修图场景中，
      // 开发者通常需要将图片 base64 放入 inputs 字典中。
      payload.inputs = {
        [inputKey]: rawBase64
      };

      console.debug("Creating Task via OpenAPI...", { 
        url: `${this.BASE_URL}/task/openapi/create`,
        workflowId 
      });

      // 发送请求
      const response = await fetch(`${this.BASE_URL}/task/openapi/create`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        mode: 'cors', // 明确使用 CORS 模式
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      // 根据 Python 脚本逻辑：检查 result.code 和 result.data.taskId
      if (result.code !== 0 || !result.data?.taskId) {
        console.error("Task creation failed:", result);
        throw new Error(result.msg || `Failed to create task (Code ${result.code})`);
      }

      const taskId = result.data.taskId;
      console.debug("Task created successfully. ID:", taskId);
      
      return await this.pollTaskStatus(taskId, apiKey);
    } catch (error: any) {
      console.error("RunningHub OpenAPI Exception:", error);
      
      // 特殊处理浏览器中最常见的 "Failed to fetch" 错误
      if (error.message === 'Failed to fetch') {
        throw new Error(
          "Network Error (Failed to fetch): 此错误通常由以下原因引起：\n" +
          "1. CORS 跨域限制：RunningHub API 可能未允许从当前域名直接调用。建议使用 CORS 代理或在本地安装 'Allow CORS' 浏览器插件测试。\n" +
          "2. 广告拦截器：部分拦截器会阻止 .ai 域名的 API 调用。\n" +
          "3. 图片过大：Base64 编码后的数据量超出了 API 服务器的接收限制。"
        );
      }
      
      throw error;
    }
  }

  private async pollTaskStatus(taskId: string, apiKey: string): Promise<string> {
    const maxAttempts = 120; // 约 6 分钟 (3s * 120)
    let attempts = 0;

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        attempts++;
        
        try {
          const response = await fetch(`${this.BASE_URL}/task/openapi/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              apiKey: apiKey,
              taskId: taskId
            })
          });
          
          if (!response.ok) throw new Error(`Status check HTTP error: ${response.status}`);
          
          const result = await response.json();

          if (result.code !== 0) {
            clearInterval(interval);
            reject(new Error(result.msg || 'Status check failed'));
            return;
          }

          // 匹配 Python 脚本中的状态逻辑
          const status = result.data?.status; 
          console.debug(`Polling status (${attempts}/${maxAttempts}): ${status}`);

          if (status === 'SUCCESS') {
            clearInterval(interval);
            const outputs = result.data.outputs;
            if (outputs && Array.isArray(outputs) && outputs.length > 0) {
              // 寻找包含 URL 的输出项
              const outputWithUrl = outputs.find(o => o.url);
              if (outputWithUrl) {
                resolve(outputWithUrl.url);
              } else {
                reject(new Error('SUCCESS but no output URL found in outputs array.'));
              }
            } else {
              reject(new Error('SUCCESS but outputs are missing.'));
            }
          } else if (status === 'FAILED') {
            clearInterval(interval);
            const errorMsg = result.data?.errorMsg || 'Internal workflow error';
            reject(new Error(`RunningHub Task Failed: ${errorMsg}`));
          }

          if (attempts >= maxAttempts) {
            clearInterval(interval);
            reject(new Error('Task monitoring timed out. The process took longer than 6 minutes.'));
          }
        } catch (error) {
          clearInterval(interval);
          reject(error);
        }
      }, 3000); // 3秒轮询一次
    });
  }
}

export const runningHubService = new RunningHubService();
