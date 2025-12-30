import React from 'react';
import { User } from '../types';

interface PricingProps {
  user: User | null;
  onStart: () => void;
}

const plans = [
  {
    label: 'Starter Boost',
    price: '$100',
    points: 440,
    bonus: '40 bonus points',
    description: 'Ideal for single listings and small teams.'
  },
  {
    label: 'Growth Pack',
    price: '$500',
    points: 2250,
    bonus: '250 bonus points',
    description: 'For agencies processing multiple properties weekly.'
  },
  {
    label: 'Studio Scale',
    price: '$1000',
    points: 4500,
    bonus: '500 bonus points',
    description: 'Best value for high-volume production teams.'
  }
];

const Pricing: React.FC<PricingProps> = ({ user, onStart }) => {
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
            <p className="text-3xl font-black text-white mt-2">$0.25 per credit</p>
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
        {plans.map((plan) => (
          <div key={plan.label} className="glass rounded-[2.5rem] p-8 border border-white/10 flex flex-col">
            <div className="text-xs uppercase tracking-widest text-gray-500">{plan.label}</div>
            <div className="mt-3 text-4xl font-black text-white">{plan.price}</div>
            <div className="mt-3 text-lg font-semibold text-indigo-300">{plan.points} credits</div>
            <div className="text-xs text-emerald-400 uppercase tracking-widest mt-1">{plan.bonus}</div>
            <p className="text-sm text-gray-500 mt-4 flex-1">{plan.description}</p>
            <button
              type="button"
              className="mt-6 px-5 py-3 rounded-2xl bg-white/10 text-white text-xs font-black uppercase tracking-widest hover:bg-white/20 transition"
            >
              Select Pack
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Pricing;
