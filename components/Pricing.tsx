import React, { useEffect, useState } from 'react';
import { PricingPack, PricingSettings, User } from '../types';
import { jobService } from '../services/jobService';

interface PricingProps {
  user: User | null;
  onStart: () => void;
}

const DEFAULT_PRICING: PricingSettings = {
  base_rate: 0.25,
  packs: [
    { label: 'Starter Boost', amount: 100, bonus: 40 },
    { label: 'Growth Pack', amount: 500, bonus: 250 },
    { label: 'Studio Scale', amount: 1000, bonus: 500 }
  ]
};

const planDescriptions: Record<string, string> = {
  'Starter Boost': 'Ideal for single listings and small teams.',
  'Growth Pack': 'For agencies processing multiple properties weekly.',
  'Studio Scale': 'Best value for high-volume production teams.'
};

const Pricing: React.FC<PricingProps> = ({ user, onStart }) => {
  const [pricing, setPricing] = useState<PricingSettings>(DEFAULT_PRICING);

  useEffect(() => {
    let mounted = true;
    jobService.getSettings()
      .then((data) => {
        if (data?.pricing && mounted) {
          const nextPricing = data.pricing as PricingSettings;
          if (nextPricing?.base_rate && Array.isArray(nextPricing.packs)) {
            setPricing(nextPricing);
          }
        }
      })
      .catch(() => {
        // Keep defaults if settings cannot load.
      });
    return () => {
      mounted = false;
    };
  }, []);

  const baseRate = pricing.base_rate || DEFAULT_PRICING.base_rate;
  const packs: PricingPack[] = pricing.packs?.length ? pricing.packs : DEFAULT_PRICING.packs;

  return (
    <div className="max-w-6xl mx-auto px-6 pt-16 pb-32 text-white">
      <div className="text-center mb-16">
        <span className="px-4 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-semibold uppercase tracking-widest">
          Credits & Recharge
        </span>
        <h1 className="text-5xl md:text-6xl font-black mt-6 mb-4 tracking-tight">
          Recharge Your Metrovan Credits
        </h1>
        <p className="text-gray-400 max-w-2xl mx-auto">
          Simple pay-as-you-go pricing. Buy credits when you need them and process more listings without waiting.
        </p>
      </div>

      <div className="glass rounded-[2.5rem] p-8 border border-white/10 mb-10">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h2 className="text-sm uppercase tracking-widest text-gray-400">Base Recharge</h2>
            <p className="text-3xl font-black text-white mt-2">${baseRate.toFixed(2)} per credit</p>
            <p className="text-sm text-gray-500 mt-3">Add exactly the number of credits you need.</p>
          </div>
          <div className="flex flex-col items-start md:items-end gap-2">
            {user && (
              <div className="text-xs text-gray-400 uppercase tracking-widest">
                Current balance
                <div className="text-lg font-bold text-white">{user.points} credits</div>
              </div>
            )}
            <button
              onClick={onStart}
              className="px-6 py-3 rounded-2xl gradient-btn text-white text-xs font-black uppercase tracking-widest"
            >
              Start Editing
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {packs.map((plan) => {
          const credits = Math.round(plan.amount / baseRate) + plan.bonus;
          return (
            <div key={plan.label} className="glass rounded-[2.5rem] p-8 border border-white/10 flex flex-col">
              <div className="text-xs uppercase tracking-widest text-gray-500">{plan.label}</div>
              <div className="mt-3 text-4xl font-black text-white">${plan.amount}</div>
              <div className="mt-3 text-lg font-semibold text-indigo-300">{credits} credits</div>
              <div className="text-xs text-emerald-400 uppercase tracking-widest mt-1">{plan.bonus} bonus points</div>
              <p className="text-sm text-gray-500 mt-4 flex-1">{planDescriptions[plan.label] || 'Flexible credit bundle.'}</p>
              <button
                type="button"
                className="mt-6 px-5 py-3 rounded-2xl bg-white/10 text-white text-xs font-black uppercase tracking-widest hover:bg-white/20 transition"
              >
                Select Pack
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Pricing;
