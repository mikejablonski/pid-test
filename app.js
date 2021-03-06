// usage
// node app.js <BrewSessionId> <SimulationModeBool(Optional)>
// example:
// sudo node app.js 1

var SIMULATION_MODE = false;

var liquidPID = require('liquid-pid');
var actualP = 0;
var pidController;

var rp = require('request-promise');
const winston = require('winston');
const fs = require('fs');
const env = process.env.NODE_ENV || 'development';
const logDir = 'logs';
// Create the log directory if it does not exist
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}
const tsFormat = () => (new Date()).toLocaleTimeString();
const logger = new (winston.Logger)({
  transports: [
    // colorize the output to the console
    new (winston.transports.Console)({
      timestamp: tsFormat,
      colorize: true,
      level: 'info'
    }),
    new (winston.transports.File)({
      filename: `${logDir}/log.json`,
      timestamp: tsFormat,
      maxsize: 5242880, // 5 MB
      maxFiles: 10,
      level: env === 'development' ? 'verbose' : 'info'
    })
  ]
});

// read the command line args
if (process.argv.length < 3) {
  console.log("Usage: sudo node app.js <BrewSessionId> <SimulationModeBool(Optional)>");
  process.exit();
}
var brewSessionId = process.argv[2];  // the brew session id

if (process.argv.length == 4) {
  // read the simulation mode boolean
  if (process.argv[3] == "true") {
    logger.info('Starting controller in simulation mode.');
    SIMULATION_MODE = true;
  }
}

var brewSession;

var loki = require('lokijs');
var db = new loki('brewSessions.json', 
  {
    autoload: true,
    autoloadCallback : loadHandler,
    autosave: true, 
    autosaveInterval: 10000 // 10 seconds
  });
var brewSessionCollection;

var dateFormat = require('dateformat');
var Gpio = require('onoff').Gpio;
var pinGpioNumHeat = 27;
var pinGpioNumPump = 6;
var actualTemp = 0;
var WindowSize = 5000;

var exec = require('child-process-promise').exec;
var logTimeSpan = 15000; // time between log entries in ms

pidController = new liquidPID({
  Pmax: WindowSize, // Max power (output) [Window Size]
  
  // Tune the PID Controller
  Kp: 25,           // PID: Kp
  Ki: 1000,         // PID: Ki
  Kd: 9             // PID: Kd
});

var relayHeat = new Gpio(pinGpioNumHeat, 'out'); // uses "GPIO" numbering
var relayPump = new Gpio(pinGpioNumPump, 'out'); // uses "GPIO" numbering
var windowStartTime = new Date().getTime();
var readVal;            // value read from the probe
var prevTemp = 0;       // keep track of the previous temp reading in case of errors from the probe
var relayStatus = '';

// These should be reset each time we do a pid loop
var tempHitTime;        // time when we hit the mash temp
var tempStopTime;       // time when we turn off the heat
var prevLogTime;        // previous logged timestamp in the pid loop
var hasHitTemp = false; // have we hit our temp yet?
var simulateTemp = 20;

function pid(targetTemp, tempHoldTime, tempHitTime, tempStopTime, prevLogTime, hasHitTemp) {
  
  pidController.setPoint(targetTemp);

  var rpOptions = {
    uri: 'http://localhost:3001/temp',
    json: true // Automatically parses the JSON string in the response
  }

  rp(rpOptions).then(function(tempData) {
    logger.debug(`Temp from api ${tempData.degreesC}.`);
    var actualTemp = Number(tempData.degreesC).toFixed(2);

    // temp must be a number
    // temp must be between 0 and 300
    // if prevTemp > 0, temp - prevTemp must not be greater than 10
    if (!isNaN(actualTemp) && actualTemp > 0 && actualTemp < 300) {
      if (prevTemp > 0) {
        if (actualTemp - prevTemp < 10) {
          // this is probably a valid temp reading.
          prevTemp = Number(actualTemp).toFixed(2);
        }
        else {
          // the temp jumped too high since last loop. error detected.
          logger.verbose(`Temp jump error! Read ${actualTemp}, using prevTemp of ${prevTemp} instead.`);
          actualTemp = Number(prevTemp).toFixed(2);
        }
      }
      else {
        // prev temp was 0, this loop just started.
        // this is probably a valid temp reading.
        prevTemp = Number(actualTemp).toFixed(2);
      }
    }
    else {
      // the temp reading was NaN or out of bounds. error detected.
      logger.verbose(`Temp range error! Read ${actualTemp}, using prevTemp of ${prevTemp} instead.`);
      actualTemp = Number(prevTemp).toFixed(2);
    }

    if (SIMULATION_MODE && !hasHitTemp) {
      simulateTemp += 5;
      actualTemp = simulateTemp;
      logger.verbose("[SIMULATION MODE] Setting temp to ", actualTemp);
      tempHoldTime = 0.25;
    }

    // get the "power" value from the pid logic
    actualP = pidController.calculate(actualTemp);	// call with the actual temp
    var now = new Date().getTime();
    
    if (!hasHitTemp && (actualTemp >= pidController.getRefTemperature())) {
      hasHitTemp = true;
      tempHitTime = now;
      tempStopTime = new Date(tempHitTime + tempHoldTime * 60000);
      
      // log the mash or boil start to the database
      if (brewSession.step == 3) { // mash
        logger.verbose(`looking for ${targetTemp}, ${tempHoldTime}`);
        // find the mash step we are working with
        mashStep = brewSession.mashSteps.find(function(ms) {
          logger.verbose(`find check ${ms.temp}, ${ms.time}`);
          return (ms.temp == targetTemp);
        });
        mashStep.mashStartTime = tempHitTime;
        mashStep.formattedMashStartTime = dateFormat(tempHitTime, "hh:MM:ss TT");  
      }
      if (brewSession.step == 5) { // boil
        brewSession.boil.boilStartTime = tempHitTime;
        brewSession.boil.formattedBoilStartTime = dateFormat(tempHitTime, "hh:MM:ss TT");
      }
      
      brewSessionCollection.update(brewSession);
      db.saveDatabase(function(err) {
        logger.info('Save database completed. Pid hit temp start time.');
        if (err) {
          logger.error('Save database error.', {error: err});
        }
      });
    }

    // log every time through the pid loop. for debugging only.
    logger.debug("hasHitTemp: %s, actualTemp: %s, targetTemp: %s, refTemp: %s, Now-windowStartTime: %s, WindowSize: %s, actualP: %s, relay: %s", hasHitTemp, actualTemp, targetTemp, pidController.getRefTemperature(), now - windowStartTime, WindowSize, actualP, relayStatus);

    if ((now - windowStartTime) > WindowSize) {
      // time to shift the Relay Window
      logger.debug("Shift relay window.");
      windowStartTime += WindowSize;
    }
    
    // changed to >= to try and prevent flipping while initially heating
    if (actualP >= (now - windowStartTime)) {
        readVal = relayHeat.readSync();
        if (readVal == 0) {
          relayHeat.writeSync(1); // 0 is off on the ssr, 1 is on
          logger.verbose("Turning heat on. Now-windowStartTime: %s, WindowSize: %s, actualP: %s", now - windowStartTime, WindowSize, actualP);
        }
        relayStatus = "ON ";
    }
    else {
        readVal = relayHeat.readSync();
        if (readVal == 1) {
          relayHeat.writeSync(0); // 0 is off on the ssr, 1 is on
          logger.verbose("Turning heat off. Now-windowStartTime: %s, WindowSize: %s, actualP: %s", now - windowStartTime, WindowSize, actualP);
        }
        relayStatus = "OFF";
    }

    // check if we need to log this temp to the database for this brew session
    // and output to the console
    // TODO: Check if changing this to >= fixes logging bug.
    if (!prevLogTime || (now - prevLogTime >= logTimeSpan)) {
      // log this temp in the database
      var logDate = new Date().getTime();
      brewSession.mashTempData.push(
        {
          time: logDate,
          formattedTime: dateFormat(logDate, "hh:MM:ss TT"),
          tempC: Math.round(actualTemp * 100) / 100,
          tempF: Math.round((actualTemp * 9/5 + 32) * 100) / 100
        }
      );
      brewSessionCollection.update(brewSession);
      db.saveDatabase(function(err) {
        logger.debug('Save database completed.');
        if (err) {
          logger.error('Save database error.', {error: err})
        }
      });
      prevLogTime = now;

      logger.verbose("hasHitTemp: %s, actualTemp: %s, targetTemp: %s, refTemp: %s, Now-windowStartTime: %s, WindowSize: %s, actualP: %s, relay: %s", hasHitTemp, actualTemp, targetTemp, pidController.getRefTemperature(), now - windowStartTime, WindowSize, actualP, relayStatus);

      logger.info('Target:%s, Temp C:%s, Temp F:%s, ActualP:%s, Relay:%s, Temp Hit:%s, Temp Hold:%s min, Now:%s, Stop:%s',
        Number(pidController.getRefTemperature()).toFixed(2),
        Number(actualTemp).toFixed(2),
        Number(actualTemp * 9/5 + 32).toFixed(2),
        actualP,
        relayStatus,
        tempHitTime ? dateFormat(tempHitTime, "hh:MM:ss:L TT") : "TBD",
        tempHoldTime,
        dateFormat(now, "hh:MM:ss:L TT"),
        tempStopTime ? dateFormat(tempStopTime, "hh:MM:ss:L TT"): "TBD");
    }

    // keep calling pid until we hit our temp hold time
    if (!tempHitTime || (tempHitTime + tempHoldTime * 60000) > now) {
      pid(targetTemp, tempHoldTime, tempHitTime, tempStopTime, prevLogTime, hasHitTemp);
    }
    else {
      logger.info("Pid loop complete.")
      var logDate = new Date().getTime();
      
      // log the pid end to the database
      
      // update some brew session details depending on the step
      if (brewSession.step == 3) { // mash
        // find the mash step we are working with
        mashStep = brewSession.mashSteps.find(function(ms) {
          return (ms.temp == targetTemp);
        });
        mashStep.mashEndTime = logDate;
        mashStep.formattedMashEndTime = dateFormat(logDate, "hh:MM:ss TT");
        logger.verbose('Setting mashEndTime for step with temp ' + mashStep.temp);
      }
      if (brewSession.step == 5) { // boil
        brewSession.boil.boilEndTime = logDate;
        brewSession.boil.formattedBoilEndTime = dateFormat(logDate, "hh:MM:ss TT");
        logger.verbose('Setting boilEndTime.');
      }
      
      // turn off the heater
      readVal = relayHeat.readSync();
      if (readVal == 0) {
        relayHeat.writeSync(1); // 0 is on, 1 is off
        logger.verbose("Turn off heater.");
      }

      // increment the brew session step number
      if (brewSession.step != 3) { // mashing can be multiple steps.
        brewSession.step = brewSession.step + 1;
      }

      brewSessionCollection.update(brewSession);
      db.saveDatabase(function(err) {
        logger.info('Save database completed. Pid loop complete.');
        if (err) {
          logger.error('Save database error.', {error: err})
        }
        checkForNextStep();
      });
    }
  })
  .catch(function (err) {
        logger.error(err);
        logger.error('Caught error in request for temp.');
  });
}

function cleanUp() {
  logger.verbose('Cleaning up...');
  if (brewSession.status != 3) { // if we're not done
    brewSession.status = 1; // mark as stopped
  }
  brewSessionCollection.update(brewSession);
  db.saveDatabase(function(err) {
    logger.info('Save database completed. Clean up.');
    if (err) {
      logger.error('Save database error.', {error: err})
    }
    // close the database
    db.close();

    // turn off the heater
    readVal = relayHeat.readSync();
    if (readVal == 1) {
      relayHeat.writeSync(0); // 0 is off on the ssr, 1 is on
      logger.verbose("Turn off heater.");
    }
    
    // turn off the pump
    readVal = relayPump.readSync();
    if (readVal == 0) {
      relayPump.writeSync(1); // 0 is on, 1 is off
      logger.verbose("Turn off pump.");
    }

    process.exit(0);
  });
}

function loadHandler() {
    logger.info("Starting controller for brew session number %d.", brewSessionId);
    if (SIMULATION_MODE) {
      logger.info("Simulation Mode is enabled.");
    }
    // if database did not exist it will be empty so I will intitialize here
    brewSessionCollection = db.getCollection('brewSessions');
    if (brewSessionCollection === null) {
        brewSessionCollection = db.addCollection('brewSessions');
    }

    // check if the brewSession already exists
    brewSession = brewSessionCollection.get(Number(brewSessionId));
    if (!brewSession) {
      // Brew session not found.
      logger.error('BrewSession not found!', {id: brewSessionId})
      cleanUp();
    }

    // update the last started time.
    brewSession.lastStarted = new Date().getTime();
    brewSessionCollection.update(brewSession);
    db.saveDatabase(function(err) {
      if (err) {
        logger.error('Save database error.', {error: err})
      }
    });

    // What is the brew session status?
    // 1 = Stopped, 2 = Running, 3 = Complete
    if (brewSession.status != 3) { // status 3 = completed
      // turn on the pump
      readVal = relayPump.readSync();
      if (readVal == 0) {
        logger.verbose("Turning on pump.");
        relayPump.writeSync(0); // 0 is on, 1 is off
      }
      // turn off the heat
      //relayHeat.writeSync(1); // 0 is on, 1 is off
      // TODO: validate this change. This seems like we want to turn off heat
      // here and let the pid loop turn it on when needed.
      logger.verbose("Turning off heat on in loadHandler.");
      relayHeat.writeSync(0); // 0 is off on the ssr, 1 is on

      checkForNextStep();
    }
    else {
      // we are complete. just exit.
      cleanUp();
    }

    logger.verbose('Exiting loadHandler.');
}

function moveValve() {
  // simulate for now
  logger.info('Simulating valve move');

  moveToNextBrewStep();
}

function moveToNextBrewStep() {
  brewSession.step += 1;
  brewSessionCollection.update(brewSession);
  db.saveDatabase(function(err) {
    logger.info('Save database completed. Next step.');
    if (err) {
      logger.error('Save database error.', {error: err})
    }
    checkForNextStep();
  });  
}

function checkForNextStep() {
  // What step are we on?
  brewSession.status = 2; // running
  brewSessionCollection.update(brewSession);
  db.saveDatabase(function(err) {
    if (err) {
      logger.error('Save database error.', {error: err})
    }
  });

  if (brewSession.step == 1) {
    // pid loop with the temp set to the first mash step, duration 1 min
    logger.info("Step 1: Heat water for mash.");
    if (brewSession.mashSteps && brewSession.mashSteps.length > 0) {
      var targetTemp = brewSession.mashSteps[0].temp - 1;
      var tempHoldTime = 1;
      tempHitTime = null;
      tempStopTime = null;
      prevLogTime = null;
      hasHitTemp = false;
      simulateTemp = 20;
      logger.info(`Starting pid with targetTemp ${targetTemp} for step 1.`);
      pid(targetTemp, tempHoldTime, tempHitTime, tempStopTime, prevLogTime, hasHitTemp);
    }
    else {
      logger.info('No mash steps found. Moving to next step.');
      moveToNextBrewStep();
    }
  } 
  else if (brewSession.step == 2) {
    // switch the output valve to the MT
    logger.info("Step 2: Transfer water to MT (dough-in).");
    moveValve();
  }
  else if (brewSession.step == 3) {
    logger.info("Step 3: Mash");
    // run the pid for each mash step
    // look for a mashEndTime to see if we need to run the pid for this mash step
    var allMashStepsComplete = true;
    for (var i=0; i < brewSession.mashSteps.length; i++) {
      var mashStep = brewSession.mashSteps[i];
      logger.info(`Looking at mash step with temp: ${mashStep.temp} and time: ${mashStep.time}.`);
      if (!mashStep.mashEndTime) {
        allMashStepsComplete = false;
        logger.info(`Starting mash step with temp: ${mashStep.temp} and time: ${mashStep.time}.`);
        var targetTemp = mashStep.temp;
        var tempHoldTime = mashStep.time;
        tempHitTime = null;
        tempStopTime = null;
        prevLogTime = null;
        hasHitTemp = false;
        simulateTemp = 20;
        pid(targetTemp, tempHoldTime, tempHitTime, tempStopTime, prevLogTime, hasHitTemp);
        break; // important! Or else we'll start all steps at the same time.
      }
    }
    if (allMashStepsComplete) {
      // increment to the next step
      brewSession.step += 1;
      brewSessionCollection.update(brewSession);
      db.saveDatabase(function(err) {
        logger.info('Save database completed. All mash steps complete.');
        if (err) {
          logger.error('Save database error.', {error: err})
        }
        checkForNextStep();
      });      
    }
  }
  else if (brewSession.step == 4) {
    logger.info("Step 4: Transfer wort to BK.");
    // switch the output valve to the BK
    moveValve();
  }
  else if (brewSession.step == 5) {
    logger.info("Step 5: Boil.");
    // run the pid for the boil
    var targetTemp = brewSession.boil.temp;
    var tempHoldTime = brewSession.boil.time;
    tempHitTime = null;
    tempStopTime = null;
    prevLogTime = null;
    hasHitTemp = false;
    simulateTemp = 20;
    pid(targetTemp, tempHoldTime, tempHitTime, tempStopTime, prevLogTime, hasHitTemp);
  }
  else {
    logger.info("Steps complete.");
    // We're done. Shut down and clean up.
    brewSession.status = 3; // complete
    brewSessionCollection.update(brewSession);
    db.saveDatabase(function(err) {
      logger.info('Save database completed. All brew session steps complete.');
      if (err) {
        logger.error('Save database error.', {error: err})
      }
      cleanUp();
    });
  }
}

// handle ctrl-c exit
process.on('SIGINT', function() {
    logger.verbose("Received SIGINT. cleaning up before exit.");
    cleanUp();
});

// handle kill process
process.on('SIGTERM', function() {
    logger.verbose("Received SIGTERM. cleaning up before exit.");
    cleanUp();
});

process.on('uncaughtException', function (err) {
  logger.error((new Date).toUTCString() + ' uncaughtException:', err.message)
  logger.error(err.stack)
  cleanUp(); // todo: pass 1 here to signal the type of exit.
})