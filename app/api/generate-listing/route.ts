import { NextRequest } from 'next/server'

// 简单的服务端调用 Gemini 文本生成接口
// 你需要在 .env.local 里配置 GEMINI_API_KEY=你的密钥

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'

async function handleGenerate(address: string, highlights: string | undefined) {
  try {
    if (!address || typeof address !== 'string') {
      return new Response(JSON.stringify({ error: '缺少地址 address' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return new Response(JSON.stringify({ error: '服务器未配置 GEMINI_API_KEY' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const prompt = `你是一名专业的房地产文案写手，请根据下面信息，生成一段适合房产中介网站/朋友圈的中文房屋简介，语气专业但自然，120-200 字左右：\n\n地址：${address}\n亮点：${highlights || '自行根据常见卖点发挥'}\n\n要求：\n- 开头一句话直接点出房源最大的优势（例如楼层/视野/学区/装修/地铁等）。\n- 中间 2-3 句介绍户型、采光、装修风格、小区配套、生活便利性。\n- 结尾一句简短的行动号召（例如“欢迎预约看房”）。\n- 不要出现“AI”“模型”“大语言模型”等描述。`

    const body = {
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
    }

    const resp = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const errText = await resp.text()
      return new Response(JSON.stringify({ error: `Gemini 调用失败: ${errText}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const data = (await resp.json()) as any
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

    if (!text) {
      return new Response(JSON.stringify({ error: 'Gemini 返回结果为空' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err: any) {
    console.error('generate-listing error', err)
    return new Response(JSON.stringify({ error: err?.message || '未知错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export async function POST(req: NextRequest) {
  const { address, highlights } = await req.json()
  return handleGenerate(address, highlights)
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address') || ''
  const highlights = searchParams.get('highlights') || undefined
  return handleGenerate(address, highlights)
}
