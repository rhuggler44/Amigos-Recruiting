// CommonJS entry for hosts whose Node.js runner can't start ES modules directly
// (e.g. cPanel "Setup Node.js App" / Phusion Passenger). Set the startup file to app.cjs.
import('./src/server.js');
