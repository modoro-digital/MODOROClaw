#!/usr/bin/env node
/**
 * Example Tool - Template for new tools
 * 
 * Usage: node example-tool.js [options] <input>
 */

const args = process.argv.slice(2);

function showHelp() {
  console.log(`
Example Tool - A template for new tools

Usage:
  node example-tool.js [options] <input>

Options:
  --help, -h     Show this help message
  --verbose, -v  Enable verbose output
  --output, -o   Specify output file

Examples:
  node example-tool.js "Hello World"
  node example-tool.js -v "Hello World"
  node example-tool.js -o result.txt "Hello World"
`);
}

function main() {
  // Parse arguments
  const options = {
    verbose: false,
    output: null,
    input: null
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    }
    
    if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
      continue;
    }
    
    if ((arg === '--output' || arg === '-o') && i + 1 < args.length) {
      options.output = args[++i];
      continue;
    }
    
    // Positional argument = input
    if (!arg.startsWith('-')) {
      options.input = arg;
    }
  }
  
  // Validate
  if (!options.input) {
    console.error('Error: No input provided');
    showHelp();
    process.exit(1);
  }
  
  // Main logic
  if (options.verbose) {
    console.log('Verbose mode enabled');
    console.log('Options:', options);
  }
  
  // Process input (replace with your actual logic)
  const result = processInput(options.input);
  
  // Output
  if (options.output) {
    const fs = require('fs');
    fs.writeFileSync(options.output, result);
    console.log(`Output written to ${options.output}`);
  } else {
    console.log(result);
  }
}

function processInput(input) {
  // Replace this with your actual processing logic
  return `Processed: ${input}`;
}

// Run if called directly
if (require.main === module) {
  main();
}

// Export for use as module
module.exports = { processInput };
