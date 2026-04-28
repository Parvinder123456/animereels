const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const GRAY = '\x1b[90m';
const MAGENTA = '\x1b[35m';
const RESET = '\x1b[0m';

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

export const logger = {
  info(msg, ...args) {
    console.log(`${GRAY}${timestamp()}${RESET} ${CYAN}[INFO]${RESET} ${msg}`, ...args);
  },
  warn(msg, ...args) {
    console.warn(`${GRAY}${timestamp()}${RESET} ${YELLOW}[WARN]${RESET} ${msg}`, ...args);
  },
  error(msg, ...args) {
    console.error(`${GRAY}${timestamp()}${RESET} ${RED}[ERROR]${RESET} ${msg}`, ...args);
  },
  debug(msg, ...args) {
    if (process.env.DEBUG) {
      console.log(`${GRAY}${timestamp()}${RESET} ${GRAY}[DEBUG]${RESET} ${msg}`, ...args);
    }
  },
  flow(msg, ...args) {
    console.log(`${GRAY}${timestamp()}${RESET} ${MAGENTA}[FLOW]${RESET} ${GREEN}${msg}${RESET}`, ...args);
  }
};
