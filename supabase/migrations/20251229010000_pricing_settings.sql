insert into app_settings (key, value)
values (
  'pricing',
  '{
    "base_rate": 0.25,
    "packs": [
      { "label": "Starter Boost", "amount": 100, "bonus": 40 },
      { "label": "Growth Pack", "amount": 500, "bonus": 250 },
      { "label": "Studio Scale", "amount": 1000, "bonus": 500 }
    ]
  }'::jsonb
)
on conflict (key) do nothing;
