import { randomBytes } from 'crypto';
import { WebSocket } from 'ws';

export const FORMAT_CONTENT_TYPE = new Map([
  ['raw-16khz-16bit-mono-pcm', 'audio/basic'],
  ['raw-48khz-16bit-mono-pcm', 'audio/basic'],
  ['raw-8khz-8bit-mono-mulaw', 'audio/basic'],
  ['raw-8khz-8bit-mono-alaw', 'audio/basic'],
  ['raw-16khz-16bit-mono-truesilk', 'audio/SILK'],
  ['raw-24khz-16bit-mono-truesilk', 'audio/SILK'],
  ['riff-16khz-16bit-mono-pcm', 'audio/x-wav'],
  ['riff-24khz-16bit-mono-pcm', 'audio/x-wav'],
  ['riff-48khz-16bit-mono-pcm', 'audio/x-wav'],
  ['riff-8khz-8bit-mono-mulaw', 'audio/x-wav'],
  ['riff-8khz-8bit-mono-alaw', 'audio/x-wav'],
  ['audio-16khz-32kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-16khz-64kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-16khz-128kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-24khz-48kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-24khz-96kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-24khz-160kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-48khz-96kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-48khz-192kbitrate-mono-mp3', 'audio/mpeg'],
  ['webm-16khz-16bit-mono-opus', 'audio/webm; codec=opus'],
  ['webm-24khz-16bit-mono-opus', 'audio/webm; codec=opus'],
  ['ogg-16khz-16bit-mono-opus', 'audio/ogg; codecs=opus; rate=16000'],
  ['ogg-24khz-16bit-mono-opus', 'audio/ogg; codecs=opus; rate=24000'],
  ['ogg-48khz-16bit-mono-opus', 'audio/ogg; codecs=opus; rate=48000'],
]);

interface PromiseExecutor {
  resolve: (value?: any) => void;
  reject: (reason?: any) => void;
}

export class Service {
  private ws: WebSocket | null = null;
  private executorMap: Map<string, PromiseExecutor>;
  private bufferMap: Map<string, Buffer>;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.executorMap = new Map();
    this.bufferMap = new Map();
  }

  private async connect(): Promise<WebSocket> {
    const isDebug = process.env.NODE_ENV !== 'production';
    const connectionId = randomBytes(16).toString('hex').toLowerCase();
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${connectionId}`;
    const ws = new WebSocket(url, {
      host: 'speech.platform.bing.com',
      origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.5060.66 Safari/537.36 Edg/103.0.1264.44',
      },
    });

    return new Promise((resolve, reject) => {
      ws.on('open', () => {
        if (isDebug) console.info('连接成功！');
        resolve(ws);
      });

      ws.on('close', (code, reason) => {
        this.ws = null;
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        for (const [key, value] of this.executorMap) {
          value.reject(`连接已关闭: ${reason} ${code}`);
        }
        this.executorMap.clear();
        this.bufferMap.clear();
        if (isDebug) console.info(`连接已关闭：${reason} ${code}`);
      });

      ws.on('error', (error) => {
        console.error(`WebSocket 连接失败：${error.message}`);
        reject(error);
      });

      ws.on('message', (message, isBinary) => {
        const pattern = /X-RequestId:([a-z0-9]*)/;
        if (!isBinary) {
          const data = message.toString();
          if (data.includes('Path:turn.start')) {
            const matches = data.match(pattern);
            const requestId = matches ? matches[1] : '';
            if (isDebug) console.debug(`开始传输：${requestId}……`);
            this.bufferMap.set(requestId, Buffer.from([]));
          } else if (data.includes('Path:turn.end')) {
            const matches = data.match(pattern);
            const requestId = matches ? matches[1] : '';
            const executor = this.executorMap.get(requestId);
            if (executor) {
              this.executorMap.delete(requestId);
              const result = this.bufferMap.get(requestId);
              executor.resolve(result);
              if (isDebug) console.debug(`传输完成：${requestId}……`);
            }
          }
        } else if (isBinary) {
          const separator = 'Path:audio\r\n';
          const data = message as Buffer;
          const contentIndex = data.indexOf(separator) + separator.length;
          const headers = data.slice(2, contentIndex).toString();
          const matches = headers.match(pattern);
          const requestId = matches ? matches[1] : '';
          const content = data.slice(contentIndex);
          if (isDebug && content.length > 0) {
            console.debug(`收到音频片段：${requestId} Length: ${content.length}`);
          }
          const buffer = this.bufferMap.get(requestId);
          if (buffer) {
            this.bufferMap.set(requestId, Buffer.concat([buffer, content]));
          }
        }
      });
    });
  }

  public async convert(ssml: string, format: string): Promise<Buffer> {
    const isDebug = process.env.NODE_ENV !== 'production';
    if (this.ws == null || this.ws.readyState !== WebSocket.OPEN) {
      if (isDebug) console.info('准备连接服务器……');
      try {
        this.ws = await this.connect();
      } catch (error) {
        console.error(`连接服务器失败：${error.message}`);
        throw error;
      }
    }

    const requestId = randomBytes(16).toString('hex').toLowerCase();
    const TIMEOUT_MS = process.env.WS_TIMEOUT && !isNaN(parseInt(process.env.WS_TIMEOUT))
      ? parseInt(process.env.WS_TIMEOUT)
      : 30000; // 默认 30 秒

    const result = new Promise<Buffer>((resolve, reject) => {
      this.executorMap.set(requestId, { resolve, reject });
      const configData = {
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: 'false',
                wordBoundaryEnabled: 'false',
              },
              outputFormat: format,
            },
          },
        },
      };
      const configMessage =
        `X-Timestamp:${Date()}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        JSON.stringify(configData);

      if (isDebug) console.info(`开始转换：${requestId}……`);
      this.ws.send(configMessage, (configError) => {
        if (configError) {
          console.error(`配置请求发送失败：${requestId} - ${configError.message}`);
          this.executorMap.delete(requestId);
          reject(configError);
          return;
        }

        const ssmlMessage =
          `X-Timestamp:${Date()}\r\n` +
          `X-RequestId:${requestId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `Path:ssml\r\n\r\n` +
          ssml;
        this.ws.send(ssmlMessage, (ssmlError) => {
          if (ssmlError) {
            console.error(`SSML消息发送失败：${requestId} - ${ssmlError.message}`);
            this.executorMap.delete(requestId);
            reject(ssmlError);
          }
        });
      });
    });

    if (this.timer) {
      if (isDebug) console.debug('收到新的请求，清除超时定时器');
      clearTimeout(this.timer);
    }
    if (isDebug) console.debug('创建新的超时定时器');
    this.timer = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (isDebug) console.debug(`已经 ${TIMEOUT_MS / 1000} 秒没有请求，主动关闭连接`);
        this.ws.close(1000);
        this.timer = null;
      }
    }, TIMEOUT_MS);

    try {
      const data = await Promise.race([
        result,
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            this.executorMap.delete(requestId);
            this.bufferMap.delete(requestId);
            reject(new Error('转换超时'));
          }, TIMEOUT_MS)
        ),
      ]);
      if (isDebug) console.info(`转换完成：${requestId}`);
      if (isDebug) console.info(`剩余 ${this.executorMap.size} 个任务`);
      return data;
    } catch (error) {
      console.error(`转换失败：${requestId} - ${error.message}`);
      throw error;
    }
  }
}

export const service = new Service();