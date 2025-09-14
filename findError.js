// This script will help find exactly where the syntax error is
// Save this as findError.js and run it

const fs = require('fs');

// Read your StoreIntelligenceService.js file
const filePath = './StoreIntelligenceService.js'; // Adjust path as needed

try {
  const content = fs.readFileSync(filePath, 'utf8');
  
  // Check for common syntax issues
  console.log('Checking for syntax issues...\n');
  
  // 1. Check for stray colons outside of objects/ternary
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    // Skip comments and strings
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
    
    // Look for colons that might be problematic
    if (line.includes(':') && !line.includes('?') && !line.includes('{') && !line.includes('case')) {
      // Check if it's inside a string
      const beforeColon = line.substring(0, line.indexOf(':'));
      const quoteCount = (beforeColon.match(/["'`]/g) || []).length;
      
      if (quoteCount % 2 === 0) { // Even number means we're not inside a string
        console.log(`Line ${index + 1}: Contains ':' outside obvious contexts`);
        console.log(`  ${line.trim()}`);
        console.log('');
      }
    }
  });
  
  // 2. Check for await without async
  const functionRegex = /^\s*(async\s+)?(\w+)\s*\([^)]*\)\s*{/gm;
  let match;
  const functions = [];
  
  while ((match = functionRegex.exec(content)) !== null) {
    functions.push({
      isAsync: !!match[1],
      name: match[2],
      index: match.index,
      line: content.substring(0, match.index).split('\n').length
    });
  }
  
  // Now check each function for await usage
  functions.forEach((func, i) => {
    const nextFunc = functions[i + 1];
    const endIndex = nextFunc ? nextFunc.index : content.length;
    const funcBody = content.substring(func.index, endIndex);
    
    if (!func.isAsync && funcBody.includes('await ')) {
      console.log(`⚠️  Function '${func.name}' at line ${func.line} uses 'await' but is not declared as 'async'`);
      console.log('');
    }
  });
  
  // 3. Check for other common issues
  console.log('\nChecking buildIntelligencePrompt method specifically...');
  const buildPromptMatch = content.match(/buildIntelligencePrompt[^{]*{/);
  if (buildPromptMatch) {
    const startIndex = content.indexOf(buildPromptMatch[0]);
    const lineNumber = content.substring(0, startIndex).split('\n').length;
    console.log(`Found buildIntelligencePrompt at line ${lineNumber}`);
    console.log(`Definition: ${buildPromptMatch[0]}`);
    
    // Check if it has async
    if (!buildPromptMatch[0].includes('async')) {
      console.log('⚠️  Missing "async" keyword!');
    }
  }
  
} catch (error) {
  console.error('Error reading file:', error.message);
  console.log('\nMake sure to adjust the filePath variable to point to your StoreIntelligenceService.js file');
}