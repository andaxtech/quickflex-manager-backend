try {
    require('./storeIntelligenceService.js');
    console.log('File loaded successfully!');
  } catch (error) {
    console.log('Error details:', error);
    console.log('Stack:', error.stack);
  }