import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

const stripeSecretKey = process.env.STRIPE_SECRET_KEY

if (!stripeSecretKey) {
  throw new Error('STRIPE_SECRET_KEY is not set')
}

const stripe = new Stripe(stripeSecretKey)

const PRICE_MAP: Record<string, string> = {
  payg: process.env.STRIPE_PRICE_PAYG || '',
  pro_500: process.env.STRIPE_PRICE_PRO_500 || '',
  team_1000: process.env.STRIPE_PRICE_TEAM_1000 || '',
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { plan, quantity = 1, userId } = body as {
      plan: 'payg' | 'pro_500' | 'team_1000'
      quantity?: number
      userId?: string | null
    }

    if (!plan || !PRICE_MAP[plan]) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
    }

    const priceId = PRICE_MAP[plan]

    const origin = req.headers.get('origin') || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: plan === 'payg' ? quantity : 1,
        },
      ],
      success_url: `${origin}/dashboard?checkout=success`,
      cancel_url: `${origin}/dashboard?checkout=cancel`,
      metadata: {
        plan,
        quantity: String(quantity ?? 1),
        user_id: userId ?? '',
      },
    })

    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    console.error('Error creating Stripe checkout session', err)
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 })
  }
}
