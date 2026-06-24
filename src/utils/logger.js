import winston from 'winston';
import WinstonDailyRotateFile from 'winston-daily-rotate-file';
import moment from 'moment-timezone';

// One line per log entry: timestamp [level]: message {metadata} + stack if present.
// Metadata objects passed as the second logger argument are appended as JSON
// instead of being silently dropped by a plain printf format.
const lineFormat = winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
  const metaString = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  const stackString = stack ? `\n${stack}` : '';
  return `${timestamp} [${level}]: ${message}${metaString}${stackString}`;
});

const dailyRotateFileTransport = new WinstonDailyRotateFile({
  filename: 'logs/log-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '40m',
  maxFiles: '15d',
  format: lineFormat,
});

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp({
      format: () => moment().tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss'),
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), lineFormat),
    }),
    dailyRotateFileTransport,
  ],
});
