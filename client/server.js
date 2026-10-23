const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_URL = process.env.API_URL || 'http://localhost:3000';
let apiKey = null; 

app.post('/api/setup', async (req, res) => {
  try {
    const accRes = await fetch(`${API_URL}/v1/accounts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Demo Company' })
    });
    const accData = await accRes.json();
    apiKey = accData.apiKey;

    const planRes = await fetch(`${API_URL}/v1/plans`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ name: 'Small Account Plan', scope: 'account', monthlyAllowance: 50, maxPerRequest: 20 })
    });
    const planData = await planRes.json();

    await fetch(`${API_URL}/v1/account/plan`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ planId: planData.id })
    });

    await fetch(`${API_URL}/v1/users`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ externalId: 'ansam' })
    });

    res.json({ message: 'Setup complete', apiKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/consume', async (req, res) => {
  if (!apiKey) return res.status(400).json({ error: 'Please run setup first' });
  
  const { userId, units } = req.body;
  const requestId = `${userId}-${Date.now()}`; 

  try {
    const response = await fetch(`${API_URL}/v1/consume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ userId, units, requestId })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/usage', async (req, res) => {
  if (!apiKey) return res.status(400).json({ error: 'Please run setup first' });
  const response = await fetch(`${API_URL}/v1/usage`, { headers: { 'X-API-Key': apiKey } });
  const data = await response.json();
  res.json(data);
});

app.post('/api/upgrade-account', async (req, res) => {
  if (!apiKey) return res.status(400).json({ error: 'Please run setup first' });
  
  const plansRes = await fetch(`${API_URL}/v1/plans`, { headers: { 'X-API-Key': apiKey } });
  const plans = await plansRes.json();
  const proPlan = plans.find(p => p.name === 'Pro'); 

  await fetch(`${API_URL}/v1/account/plan`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ planId: proPlan.id })
  });
  res.json({ message: 'Account upgraded to Pro' });
});

app.listen(3001, () => console.log('Example Client running on port 3001'));
