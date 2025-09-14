// test-syntax.js
console.log('1. Starting test...');

try {
  console.log('2. Testing intelligenceConfig...');
  const config = require('./intelligenceConfig');
  console.log('3. Config loaded successfully');
  console.log('Config keys:', Object.keys(config));
} catch (error) {
  console.error('Error in intelligenceConfig:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}

try {
  console.log('4. Testing StoreIntelligenceService...');
  const StoreIntelligenceService = require('./storeIntelligenceService');
  console.log('5. Service loaded successfully');
} catch (error) {
  console.error('Error in StoreIntelligenceService:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}

console.log('6. All modules loaded successfully!');