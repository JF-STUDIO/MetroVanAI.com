
import React from 'react';
import { CREDIT_PLANS, POINT_PRICE_PER_UNIT } from '../constants';
import { User, CreditPlan } from '../types';
import { storage } from '../services/localStorageService';

interface PricingProps {
  user: User;
  onUpdateUser: (user: User) => void;
}

const Pricing: React.FC<PricingProps> = ({ user, onUpdateUser }) => {
  const purchasePoints = (plan: CreditPlan) => {
    const confirmPurchase = window.confirm(`Purchase ${plan.amount} points for $${plan.price.toFixed(2)}?`);
    if (confirmPurchase) {
      const updatedUser = { ...user, points: user.points + plan.amount };
      storage.setUser(updatedUser);
      onUpdateUser(updatedUser);
      alert("Successfully added points to your account!");
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-20">
      <div className="text-center mb-16">
        <h2 className="text-4xl font-black mb-4 uppercase tracking-tighter">REPLENISH YOUR <span className="text-indigo-400">POINTS</span></h2>
        <p className="text-gray-400">Simple pay-as-you-go pricing. Each edit consumes 1 point.</p>
        <p className="text-indigo-400/80 mt-2 font-medium">Standard pricing: ${POINT_PRICE_PER_UNIT} USD per point.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {CREDIT_PLANS.map(plan => (
          <div key={plan.id} className={`glass p-10 rounded-[3rem] text-center border-t-8 ${plan.id === 'pro' ? 'border-indigo-500 scale-105 shadow-2xl shadow-indigo-500/10' : 'border-white/10 hover:border-white/20'} transition`}>
            {plan.id === 'pro' && (
              <span className="px-3 py-1 bg-indigo-500 text-white text-[10px] font-black uppercase rounded-full mb-6 inline-block">Popular Choice</span>
            )}
            <h3 className="text-2xl font-bold mb-2 uppercase tracking-wide">{plan.label}</h3>
            <div className="text-6xl font-black mb-6 tracking-tighter">
              {plan.amount}
              <span className="text-xl text-gray-500 ml-2 font-normal">Points</span>
            </div>
            <div className="text-indigo-400 text-2xl font-bold mb-8">${plan.price.toFixed(2)}</div>
            
            <ul className="text-sm text-gray-400 space-y-4 mb-10">
              <li className="flex items-center gap-2 justify-center">
                <i className="fa-solid fa-check text-green-500"></i>
                Professional AI Retouching
              </li>
              <li className="flex items-center gap-2 justify-center">
                <i className="fa-solid fa-check text-green-500"></i>
                Full Engine Access
              </li>
              <li className="flex items-center gap-2 justify-center">
                <i className="fa-solid fa-check text-green-500"></i>
                Batch Processing Enabled
              </li>
            </ul>

            <button 
              onClick={() => purchasePoints(plan)}
              className={`w-full py-4 rounded-2xl font-bold transition ${plan.id === 'pro' ? 'gradient-btn text-white' : 'bg-white/5 border border-white/10 hover:bg-white/10'}`}
            >
              Get Points Now
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Pricing;
