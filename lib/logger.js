import winston from 'winston';
import WinstonDailyRotateFile from 'winston-daily-rotate-file';
import moment from "moment-timezone"; // install with npm i moment-timezone

// Define the log format
const logFormat = winston.format.combine(
    winston.format.timestamp({
      format: () => moment().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss"),
    }),
    winston.format.printf(({ timestamp, level, message }) => {
        return `${timestamp} [${level}]: ${message}`;
    })
);

// Create the daily rotate file transport
const dailyRotateFileTransport = new WinstonDailyRotateFile({
    filename: 'logs/log-%DATE%.log', 
    datePattern: 'YYYY-MM-DD',       
    zippedArchive: false,             
    maxSize: '40m',                  
    maxFiles: '15d'                  
});

// Create the winston logger
export const logger = winston.createLogger({
    level: 'info',                   
    format: logFormat,
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        dailyRotateFileTransport        
    ]
});
