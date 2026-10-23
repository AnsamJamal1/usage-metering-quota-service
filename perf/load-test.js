const autocannon = require('autocannon');

async function runTest() {
  console.log('Setting up test data...');
  
  const accRes = await fetch('http://localhost:3000/v1/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Load Test Account' })
  });
  const accData = await accRes.json();
  const apiKey = accData.apiKey;

  const planRes = await fetch('http://localhost:3000/v1/plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ name: 'Unlimited', scope: 'account', monthlyAllowance: 10000000, maxPerRequest: 10000 })
  });
  const planData = await planRes.json();
  
  await fetch('http://localhost:3000/v1/account/plan', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ planId: planData.id })
  });

  await fetch('http://localhost:3000/v1/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ externalId: 'load-user' })
  });

  console.log('Starting load test...');
  
  const instance = autocannon({
    url: 'http://localhost:3000/v1/consume',
    connections: 50, 
    duration: 10,    
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    },
    body: JSON.stringify({
      userId: 'load-user',
      units: 1,
      requestId: 'req-' + Math.random() 
    })
  }, (err, result) => {
    if (err) console.error(err);
    console.log('\n--- Load Test Results ---');
    console.log(`Requests/sec: ${result.requests.average}`);
    console.log(`Latency (p99): ${result.latency.p99} ms`);
    console.log(`Total Requests: ${result.requests.total}`);
    console.log(`Errors: ${result.errors}`);
  });

  autocannon.track(instance);
}

runTest().catch(console.error);
