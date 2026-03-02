import fs from 'fs';
import sharp from 'sharp';
import { logger } from './logger.js';
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_API_KEY,
  ANTHROPIC_DEFAULT_SONNET_MODEL,
} from './config.js';

export async function processVision(
  imagePath: string,
  prompt: string,
): Promise<string> {
  const baseUrl = ANTHROPIC_BASE_URL || 'https://openrouter.ai/api';
  const apiKey = ANTHROPIC_API_KEY;
  const model = ANTHROPIC_DEFAULT_SONNET_MODEL || 'qwen/qwen-2-vl-72b-instruct';

  logger.info(
    { imagePath, model, baseUrl },
    'Processing and resizing image for multimodal model',
  );

  try {
    // Resize image to max 1024px on the longest side to avoid token limit overflow (128k)
    // Most multimodal models handle this resolution perfectly for description/OCR.
    const imageBuffer = fs.readFileSync(imagePath);
    const resizedBuffer = await sharp(imageBuffer)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    const base64Image = resizedBuffer.toString('base64');
    const mimeType = 'image/jpeg';

    // Try OpenAI-compatible chat completions first
    const url = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const fullUrl = `${url}v1/chat/completions`;

    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  prompt || '이 이미지를 상세히 설명해줘. 한국어로 답변해줘.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vision API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;
    const result =
      data.choices?.[0]?.message?.content || 'No description generated.';

    logger.info('Image processing completed');
    return result;
  } catch (err) {
    logger.error(
      { err, imagePath },
      'Failed to process image with multimodal model',
    );
    throw err;
  }
}
