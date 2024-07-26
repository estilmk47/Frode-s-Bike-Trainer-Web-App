// Documentation: https://www.bluetooth.com/specifications/specs/gatt-specification-supplement/
// PageNr: 84
const CPC_FLAG_FIELD = Object.freeze({
    PedalPowerBalance:              {index: 0,  fieldSize: 1},
    PedalPowerBalanceReference:     {index: 1,  fieldSize: 0}, 
    AccumulatedTorque:              {index: 2,  fieldSize: 2}, // -> 1/32 Newton-meter
    AccumulatedTorqueSource:        {index: 3,  fieldSize: 0},
    RevolutionData:                 {index: 4,  fieldSize: 6}, // Struct: [0:4] Cum -> revolutions, [5:6] Time -> 1/2048 s
    CrankRevolutionData:            {index: 5,  fieldSize: 4}, // Struct: [0:2] CumCrank -> revolutions, [3:4] Time -> 1/1024 s
    ExtremeForceMagnitudes:         {index: 6,  fieldSize: 4}, 
    ExtremeTorqueMagnitudes:        {index: 7,  fieldSize: 4}, 
    ExtremeAnglesPresent:           {index: 8,  fieldSize: 3}, 
    TopDeadSpotAngle:               {index: 9,  fieldSize: 2}, 
    BottomDeadSpotAngle:            {index: 10, fieldSize: 2}, 
    AccumulatedEnergy:              {index: 11, fieldSize: 2}, // -> kJ
    OffsetCompensationIndicator:    {index: 12, fieldSize: 0}
    /* Unused flags 13 - 15 */
});

class RevolutionData{
    constructor(){
        this.lastNonZeroValue = 0;
        this.prevStaleness = true;
        this.prevRevs = null;
        this.prevTime = null;
    }
    reset(){
        this.prevStaleness = true;
        this.prevRevs = null;
        this.prevTime = null;
    }
}

class Bike_BLE {
    #debug = {
        basePower: 100,
        initiated: false,
        looping: false
    }

    constructor(){
        this.self = null;
        this.name = null;
        this.connecting = false;
        this.lastNotificationTimeStamp = null;
        
        this.powerAvailable = false;
        this.speedAvailable = false;
        this.cadenceAvailable = false;

        this.power = 0;
        this.accumulatedEnergy = 0;
        this.accumulatedDistance = 0;
        this.speed = 0;
        this.cadence = 0;  //rpm

        //BLE CHARACTERISTIC VALUES
        this.wheelRevolutionData = new RevolutionData();
        this.crankRevolutionData = new RevolutionData();
    }
    #findPayloadIndex(flag, flagIndex){
        if(flag[flagIndex]){
            //Data (payload) index starts at 4 since data index before is the flag field and power ([0:1]-> flag, [2:3]-> power, [4:]-> ?), and data after is dependant on flag field
            let payloadIndex = 4;
            for(let i = 0; i < flagIndex; i++){
                if(flag[i]){
                    payloadIndex += CPC_FLAG_FIELD[Object.keys(CPC_FLAG_FIELD)[i]].fieldSize; 
                }
            }
            return payloadIndex;
        }
        else{
            return null;
        }
    }
    connect(){
        this.connecting = true;
        if(this.self != null){
            this.self.gatt.disconnect();
        }    
    
        if(bluetooth_available()){
            var serviceUUID = 0x1818;            //Cycling power
            var characteristicUUID = 0x2A63;     //Cycling power measurement
            var options = {
                filters: [
                    { services: [serviceUUID] }
                ],
                optionalServices: [characteristicUUID]
            }
            
            navigator.bluetooth.requestDevice(options)
            .then(device => {
                // Connect device
                this.self = device;
                this.name = device.name; 
                device.addEventListener('gattimeStamperverdisconnected', this.onDisconnected);                                  // Set up event listener for when device getimeStamp disconnected.
                return device.gatt.connect();                                                                                   // AttemptTimeStamp to connect to remote GATT Server.
            })
            .then(server => {
                return server.getPrimaryService(serviceUUID);            
            })    
            .then(service => {
                return service.getCharacteristic(characteristicUUID);            
            })    
            .then(characteristic => {
                characteristic.startNotifications();
                characteristic.addEventListener("characteristicvaluechanged", (event) => this.#notifyHandler(event, this)); 
                this.powerAvailable = true;    
                this.connecting = false; //Not connecting anymore since we now are fully connected 
            })
            .catch((error) => {
                console.error(`Something went wrong. ${error}`);
                this.onDisconnected();
            });
        }
    }

    onDisconnected(event){
        //const device = event.target;
        this.self = null;
        this.name = null; 
        this.connecting = false;
        this.lastNotificationTimeStamp = null;

        this.powerAvailable = false;
        this.speedAvailable = false;
        this.cadenceAvailable = false;
        this.power = 0;
        this.speed = 0;
        this.cadence = 0; 
        this.accumulatedEnergy = 0;
        this.accumulatedDistance = 0;

        this.wheelRevolutionData.reset();
        this.crankRevolutionData.reset();

        this.#debug.initiated = false;
    }
    #notifyHandler(event, object){     
        const index0multiplier = Math.pow(2, 0);
        const index1multiplier = Math.pow(2, 8);   
        const index2multiplier = Math.pow(2,16);
        const index3multiplier = Math.pow(2,32);

        let now = new Date().getTime();

        let dt  = 0; // [s]
        if(object.lastNotificationTimeStamp){
            dt  = (now - object.lastNotificationTimeStamp)/1000; // ms -> s
        }
        if(dt > 3){
            dt  = 0; //Effect: Asume user has disconnected
        }

        let flag = event.target.value.getUint8(0) + event.target.value.getUint8(1)*100; // I know this looks wierd, but this is actually how you get the flag field
        flag = convertTo16BitArray(flag);

        //Energy
        if(flag[CPC_FLAG_FIELD.AccumulatedEnergy.index]){
            let payloadIndex = this.#findPayloadIndex(
                flag,
                CPC_FLAG_FIELD.AccumulatedEnergy.index
            );
            
            let data = event.target.value.getUint8(payloadIndex) + event.target.value.getUint8(payloadIndex+1)*index1multiplier;
            object.accumulatedEnergy = data; // Given in kJ
            //console.log(data) 
        }
        else if(object.powerAvailable){
            // console.log(dt*object.power/1000);
            // CONSIDER: find a more reliable method
            object.accumulatedEnergy += dt*object.power/1000; // J -> kJ
        }

        //Power 
        object.powerAvailable = true;
        let payloadIndex = 2;
        object.power = event.target.value.getUint8(payloadIndex)*index0multiplier + event.target.value.getUint8(payloadIndex+1)*index1multiplier;
        
        //Speed & Distance
        if(flag[CPC_FLAG_FIELD.RevolutionData.index]){
            object.speedAvailable = true;
            let payloadIndex = this.#findPayloadIndex(
                flag,
                CPC_FLAG_FIELD.RevolutionData.index
            );

            let wheelRevs = event.target.value.getUint8(payloadIndex)*index0multiplier + event.target.value.getUint8(payloadIndex+1)*index1multiplier + event.target.value.getUint8(payloadIndex+2)*index2multiplier + event.target.value.getUint8(payloadIndex+3)*index3multiplier;
            let wheelTime = event.target.value.getUint8(payloadIndex+4)*index0multiplier + event.target.value.getUint8(payloadIndex+5)*index1multiplier;
            let prevRevs = object.wheelRevolutionData.prevRevs;
            let prevTime = object.wheelRevolutionData.prevTime;
            
            let configuration = 1; //TODO: get from flag field
            let rpm = 0;
            
            if(!object.wheelRevolutionData.prevStaleness){
                let dTime = wheelTime - prevTime; //TODO: fix roll over
                let dRevs = wheelRevs - prevRevs;

                if(dTime > 0){
                    rpm = (configuration ? 2048 : 1024)*60*dRevs/dTime;
                    if(rpm) object.wheelRevolutionData.lastNonZeroValue = rpm;  // CONSIDER: Finding a better solution to speed blips
                }
            }
            else{
                object.wheelRevolutionData.prevStaleness = false;
            }
            if(!rpm && object.power) rpm = object.wheelRevolutionData.lastNonZeroValue;

            object.wheelRevolutionData.prevRevs = wheelRevs;
            object.wheelRevolutionData.prevTime = wheelTime;

            const wheelRadius = 0.311; // [meters] 700x18c
            const kmh_rpm = 3/25*Math.PI*wheelRadius;
            object.speed = kmh_rpm*rpm;
            object.accumulatedDistance = wheelRevs*2*Math.PI*wheelRadius;
        }        

        //Cadence
        if(flag[CPC_FLAG_FIELD.CrankRevolutionData.index]){
            object.cadenceAvailable = true;
            let payloadIndex = this.#findPayloadIndex(
                flag,
                CPC_FLAG_FIELD.CrankRevolutionData.index
            );

            let crankRevs = event.target.value.getUint8(payloadIndex)*index0multiplier + event.target.value.getUint8(payloadIndex+1)*index1multiplier;
            let crankTime = event.target.value.getUint8(payloadIndex+2)*index0multiplier + event.target.value.getUint8(payloadIndex+3)*index1multiplier;
            let prevRevs = object.crankRevolutionData.prevRevs;
            let prevTime = object.crankRevolutionData.prevTime;

            let rpm = 0;
            
            if(!object.crankRevolutionData.prevStaleness){
                let dTime = crankTime - prevTime;
                let dRevs = crankRevs - prevRevs;

                if(dTime > 0 && dRevs >= 0){    //CONSIDER: finding a better solution to roll over / overflows
                    rpm = 1024*60*dRevs/dTime;
                    if(rpm) object.crankRevolutionData.lastNonZeroValue = rpm;
                }
                else{                       
                    rpm = object.cadence;       //Use old value in case of annomolies in the data
                }
            }
            else{
                object.crankRevolutionData.prevStaleness = false;
            }

            object.crankRevolutionData.prevRevs = crankRevs;
            object.crankRevolutionData.prevTime = crankTime;
            object.cadence = rpm;
        }     

        object.lastNotificationTimeStamp = now;  
        //CONSIDER implement other/more features (as seen in CPC_FLAG_FIELD)
    }
    debugSetBasePower(power){
        this.#debug.basePower = power;
    }
    debug(init = true){
        // TODO: ironically this function has 
        if (init){
            this.self = "debug";
            this.name = "Debug Cycle"; 
        }
        if ((init && !this.#debug.looping) || (!init && this.#debug.looping)) {
            if (!this.#debug.looping) this.#debug.looping = true;
            setTimeout((event) => this.debug(false), 1000);
        }
        let dt = 0;
        let now = new Date().getTime();

        if (this.lastNotificationTimeStamp){
            dt = now - this.lastNotificationTimeStamp;
            dt /= 1000;
        }
        
        this.lastNotificationTimeStamp = now;

        this.accumulatedEnergy += dt*this.power/1000; //J -> kJ
        this.accumulatedDistance += dt*this.speed*1000/3600; // km/h -> m

        this.power = this.#debug.basePower > 0 ? Math.floor(Math.random()*50) + this.#debug.basePower : 0;
        this.cadence = Math.floor(Math.random()*20) + 80;
        this.speed = (Math.floor(Math.random()*50) + 300)/10;        

        this.speedAvailable = true;
        this.powerAvailable = true;
        this.cadenceAvailable = true;
    }
}

class HR_BLE {
    constructor(){
        this.self = null;
        this.name = null;
        this.heartRate = null;

        this.accumulatedHeartBeats = 0;
        this.lastNotificationTimeStamp = null;
    }
    connect(){
        if(this.self != null){
            this.self.gatt.disconnect();
        }    
    
        if(bluetooth_available()){
            var serviceUUID = 0x180D;            //Heart Rate UUID
            var characteristicUUID = 0x2A37;     //Heart Rate Masurement
            var options = {
                filters: [
                    { services: [serviceUUID] }
                ],
                optionalServices: [characteristicUUID]
            }
            
            navigator.bluetooth.requestDevice(options)
            .then(device => {
                // Connect device
                this.self = device;
                this.name = device.name;
                device.addEventListener('gattimeStamperverdisconnected', this.onDisconnected);
                return device.gatt.connect();
            })
            .then(server => {
                return server.getPrimaryService(serviceUUID);            
            })    
            .then(service => {
                return service.getCharacteristic(characteristicUUID);            
            })    
            .then(characteristic => {
                characteristic.startNotifications();
                characteristic.addEventListener("characteristicvaluechanged", (event) => this.#notifyHandler(event, this));        
            })
            .catch((error) => {
                console.error(`Something went wrong. ${error}`);
                this.onDisconnected();
            });
        }
    }

    #notifyHandler(event, object){   
        let now = new Date().getTime();
        let dt = (now - this.lastNotificationTimeStamp)/1000; // [s]
        if (dt > 0 && dt < 6){
            let beats = dt/60*object.heartRate;
            object.accumulatedHeartBeats += beats;
        }
        this.lastNotificationTimeStamp = now;
        object.heartRate = event.target.value.getUint8(1); // TODO: Fix -> Max heartrate 255, then rollover   
    }

    onDisconnected(event){
        //const device = event.target;
        this.self = null;
        this.name = null;
        this.heartRate = null;
        this.lastNotificationTimeStamp = null;
    }
    
}

class SRAT_BLE {
    constructor(){
        this.self = null;
        this.name = null;
        this.connecting = false;
        this.mode = 0;
        this.bts  = [false, false, false, false, false, false];
        this.axis = {a1: 0, a2: 0, roll: 0, pitch: 0, yaw: 0};
    }
    connect(){
        this.connecting = true;
        if(this.self != null){
            this.self.gatt.disconnect();
        }    
    
        if(bluetooth_available()){
            var serviceUUID = "be30f8d4-4711-11ee-be56-0242ac120002";            //SRAT+ Service
            var characteristicUUID = "be30f8d4-4711-11ee-be56-0242ac120003";     //SRAT+ Output Characteristic
            var options = {
                acceptAllDevices: true,
                // filters: [
                //     { services: [serviceUUID] }
                // ],
                optionalServices: [serviceUUID, characteristicUUID]
                
            }
            
            navigator.bluetooth.requestDevice(options)
            .then(device => {
                // Connect device
                this.self = device;
                this.name = device.name; 
                device.addEventListener('gattimeStamperverdisconnected', this.onDisconnected);                                  // Set up event listener for when device getimeStamp disconnected.
                return device.gatt.connect();                                                                                   // AttemptTimeStamp to connect to remote GATT Server.
            })
            .then(server => {
                return server.getPrimaryService(serviceUUID);            
            })    
            .then(service => {
                return service.getCharacteristic(characteristicUUID);            
            })    
            .then(characteristic => {
                characteristic.startNotifications();
                characteristic.addEventListener("characteristicvaluechanged", (event) => this.#notifyHandler(event, this));  
                this.connecting = false; //Not connecting anymore since we now are fully connected 
            })
            .catch((error) => {
                console.error(`Something went wrong. ${error}`);
                this.onDisconnected();
            });
        }
        else{
            connecting = false;
        }
    }
    onDisconnected(event){
        this.self = null;
        this.name = null;
        this.connecting = false;
        this.mode = 0;
        this.bts  = [false, false, false, false, false, false];
        this.axis = {a1: 0, a2: 0, roll: 0, pitch: 0, yaw: 0};
    }
    #notifyHandler(event, object){  
        this.mode = event.target.value.getUint8(0) >> 6;
        let tmp = event.target.value.getUint8(0);
        for(var i = 0; i < 6; i++){
            this.bts[i] = (tmp & 0b1) ? true : false;
            tmp = tmp >> 1;
        }
        this.axis.a1 = event.target.value.getUint8(1);
        this.axis.a2 = event.target.value.getUint8(2);
        this.axis.roll = event.target.value.getUint8(3);
        this.axis.pitch = event.target.value.getUint8(4);
        this.axis.yaw = event.target.value.getUint8(5);
    }
}

const SESSION_ACTIONS = Object.freeze({
    START: 0,
    STOP: 1,
    LAP: 2,
    SAVE: 3,
    DOWNLOAD: 4,
    RESTART: 5
});

class SessionData{
    constructor(){
        // this.updateOnBikeNotification = true;
        // this.updateOnHRNotification = false;
        this.restart();
    }

    restart(){
        this.timeStart = 0; // new Date().getTime();
        this.timeEnd = 0;
        this.laps = [0];
        this.hr = [];
        this.pwr = [];
        this.cadence = [];
        this.speed = [];
        this.accumulatedTime = [];
        this.accumulatedDistance = [];
        this.accumulatedEnergy = [];
        this.accumulatedHeartBeats = [];

        this.lapStartIndex = 0;
        this.maxPwr = 0;
        this.maxPulse = 0;
        this.maxCadance = 0;
        this.maxSpeed = 0;
    }

    start(){
        this.timeStart = new Date().getTime();
        this.sampleOn = true;
        // this.sample();
    }
    stop(){
        this.sampleOn = false;
        this.timeEnd = new Date().getTime();
    }
    lap(){
        if(this.timeStart == 0) return;
        let dt = new Date().getTime() - this.timeStart;
        this.laps.push(dt);
        this.lapStartIndex = this.pwr.length-1;
    }

    sample(pwr, cadence = null, speed = null, accDist = null, accEnergy = null, hr = null, accHr = null){
        if(this.timeStart == 0) return;
        if(this.sampleOn == false) return;
        if(pwr == undefined || pwr == null) return;
        
        let dt = new Date().getTime() - this.timeStart;

        this.pwr.push(pwr);
        this.cadence.push(cadence);
        this.speed.push(speed);
        this.accumulatedDistance.push(accDist);
        this.accumulatedEnergy.push(accEnergy);
        this.hr.push(hr);
        this.accumulatedHeartBeats.push(accHr);
        this.accumulatedTime.push(dt);

        if (pwr && pwr > this.maxPwr) this.maxPwr = pwr;
        if (cadence && cadence > this.maxCadance) this.maxCadance = cadence;
        if (hr && hr > this.maxPulse) this.maxPulse = hr;
        if (speed && speed > this.maxSpeed) this.maxSpeed = speed;
        
    }

    getSessionDataAsJSON(){
        let data = {
            startTime: this.timeStart,
            laps: this.laps,
            power: this.pwr,
            cadence: this.cadence,
            speed: this.speed,
            accumulatedDistance: this.accumulatedDistance,
            accumulatedEnergy: this.accumulatedEnergy
        }
        return JSON.stringify(data);
    }
}

class BLE{
    constructor(rootDirectory = "/jonekra/beta/BTA/BLE/", serverDirectory = null){
        this.bike = new Bike_BLE();
        this.hr = new HR_BLE();
        this.steeringWheel = new SRAT_BLE();
        this.sessionData = new SessionData();
        this.displayMode = "Total"; // "Total" and "Lap" are the only allowed values
        this.screenEl = null;
        this.renderActive = false;
        this.sampleRateMS = 450;
        this.refreshRateMS = 41; // 24 fps
        this.lastSampleTS = {bike: null, hr: null};
        this.initiated = false;
        this.rootDirectory = rootDirectory;
        this.serverDirectory = serverDirectory;
    }

    init(){
        if(!bluetooth_available()) {
            alert("Bluetooth module initiated, however, your browser do not support bluetooth! [Consider changing to chrome]");
            return;
        }
        if(false){ // TODO: if ble css not loaded 
            alert("Can not load bluetooth module before bluetooth css");
            return;
        }
        if(this.initiated) return;
        this.initiated = true;

        let bleSettingsScreen = document.createElement("div");
        bleSettingsScreen.id = "bleSettings";
            let deviceMenu = document.createElement("div");
            deviceMenu.id = "deviceMenu";
                let deviceMenuTitle = document.createElement("h1");
                deviceMenuTitle.innerHTML = "Device Menu";
                let bleDeviceBike = document.createElement("div");
                bleDeviceBike.className = "bleDevice";
                bleDeviceBike.id = "bleBike";
                bleDeviceBike.innerHTML = "<img src='"+this.rootDirectory+"Bike.png' class='bleDeviceIcon'> <div id='bikeName'>Bike</div>";
                bleDeviceBike.addEventListener("click", (event) => clickConenct(event, this.bike));
                let bleDeviceHR = document.createElement("div");
                bleDeviceHR.className = "bleDevice";
                bleDeviceHR.id = "bleHRM";
                bleDeviceHR.innerHTML = "<img src='"+this.rootDirectory+"HeartRate.png' class='bleDeviceIcon'> <div id='hrmName'>Heart Rate Monitor</div>";
                bleDeviceHR.addEventListener("click", (event) => clickConenct(event, this.hr));
                let bleDeviceSRAT = document.createElement("div");
                bleDeviceSRAT.className = "bleDevice";
                bleDeviceSRAT.id = "bleSRAT";
                bleDeviceSRAT.innerHTML = "<img src='"+this.rootDirectory+"SteeringWheel.png' class='bleDeviceIcon'> <div id='sratName'>SRAT+</div>";
                bleDeviceSRAT.addEventListener("click", (event) => clickConenct(event, this.steeringWheel));
                
                deviceMenu.appendChild(deviceMenuTitle);
                deviceMenu.appendChild(bleDeviceBike);
                deviceMenu.appendChild(bleDeviceHR);
                deviceMenu.appendChild(bleDeviceSRAT);

            bleSettingsScreen.appendChild(deviceMenu);

            let session = document.createElement("div");
            session.id = "bleSession";
            session.innerHTML = "<h2> Session </h2>";
            let sessionStatsTop = document.createElement("div");
            sessionStatsTop.id = "sessionStatsTop";
                let timeLine = document.createElement("div");
                timeLine.id = "bleSessionTimeLine";
                    let timeTotal = document.createElement("div");
                    timeTotal.id = "bleSessionTimeTotal";
                    timeTotal.innerHTML = "00:00:00";
                    let timeLap = document.createElement("div");
                    timeLap.id = "bleSessionTimeLap";
                    timeLap.innerHTML = "00:00:00";
                    timeLine.appendChild(timeTotal);
                    timeLine.appendChild(timeLap);
                sessionStatsTop.appendChild(timeLine);
                let sessionStatsCanvas = document.createElement("canvas");
                sessionStatsCanvas.id = "sessionStatsGraph";
                // sessionStatsTop.appendChild(sessionStatsCanvas);
            
            session.appendChild(sessionStatsTop);

            let sessionControls = document.createElement("div");
            sessionControls.id = "bleSessionControls";

            let sessionControlsStart = document.createElement("div");
            sessionControlsStart.className = "sessionControlsBT";
            sessionControlsStart.id = "bleSessionStart";
            sessionControlsStart.innerHTML = "START";
            let sessionControlsLap = document.createElement("div");
            sessionControlsLap.className = "sessionControlsBT";
            sessionControlsLap.id = "bleSessionLap";
            sessionControlsLap.innerHTML = "LAP";
            sessionControlsLap.style.display = "none";
            let sessionControlsStop = document.createElement("div");
            sessionControlsStop.className = "sessionControlsBT";
            sessionControlsStop.id = "bleSessionStop";
            sessionControlsStop.innerHTML = "STOP";
            sessionControlsStop.style.display = "none";
            let sessionControlsSave = document.createElement("div");
            sessionControlsSave.className = "sessionControlsBT";
            sessionControlsSave.innerHTML = "SAVE";
            sessionControlsSave.id = "bleSessionSave";
            sessionControlsSave.style.display = "none";
            let sessionControlsDownload = document.createElement("div");
            sessionControlsDownload.className = "sessionControlsBT";
            sessionControlsDownload.innerHTML = "DOWNLOAD";
            sessionControlsDownload.id = "bleSessionDownload";
            sessionControlsDownload.style.display = "none";
            let sessionControlsRestart = document.createElement("div");
            sessionControlsRestart.className = "sessionControlsBT";
            sessionControlsRestart.id = "bleSessionRestart";
            sessionControlsRestart.innerHTML = "RESTART";
            sessionControlsRestart.style.display = "none";

            sessionControlsStart.addEventListener("click", (event) => 
                clickSessionHandler(event, this.sessionData, SESSION_ACTIONS.START)
            );
            sessionControlsLap.addEventListener("click", (event) => 
                clickSessionHandler(event, this.sessionData, SESSION_ACTIONS.LAP)
            );
            sessionControlsStop.addEventListener("click", (event) => 
                clickSessionHandler(event, this.sessionData, SESSION_ACTIONS.STOP)
            );
            sessionControlsSave.addEventListener("click", (event) => 
                clickSessionHandler(event, this.sessionData, SESSION_ACTIONS.SAVE)
            );
            sessionControlsDownload.addEventListener("click", (event) => 
                clickSessionHandler(event, this.sessionData, SESSION_ACTIONS.DOWNLOAD)
            );
            sessionControlsRestart.addEventListener("click", (event) => 
                clickSessionHandler(event, this.sessionData, SESSION_ACTIONS.RESTART)
            );

            sessionControls.appendChild(sessionControlsStart);
            sessionControls.appendChild(sessionControlsLap);
            sessionControls.appendChild(sessionControlsStop);
            sessionControls.appendChild(sessionControlsSave);
            sessionControls.appendChild(sessionControlsDownload);
            sessionControls.appendChild(sessionControlsRestart);

            session.appendChild(sessionControls);

            let sessionStatsBottom = document.createElement("div");
            sessionStatsBottom.id = "sessionStatsBottom";
            const dataTypes = ["HeartRate", "Power", "Cadence", "Speed", "Energy"];
            const dataMetrics = ["Cur", "Acc", "Avg", "Max"];
            let sessionStatTable = document.createElement("div");
            sessionStatTable.id = "sessionStatTable";
            sessionStatTable.addEventListener("click", (event) => this.swapDisplayMode());
            for(var i = -1; i < dataTypes.length; i++){
                let dataLine = document.createElement("div");
                dataLine.className = "sessionStatTableLine";
                for(var j = -1; j < dataMetrics.length; j++){
                    let dataElement = document.createElement("div");
                    dataElement.className = "sessionStatTableElement";
                    if (i < 0){
                        if(j >= 0){
                            dataElement.innerHTML = dataMetrics[j];
                        }
                        else{
                            dataElement.innerHTML = "Total";
                            dataElement.id = "sessionStatTableName";
                        }
                        dataLine.style.borderBottom = "1px solid white";
                        dataLine.appendChild(dataElement);
                        continue;                        
                    }
                    if (j < 0){
                        dataElement.innerHTML = "<img src='"+this.rootDirectory+dataTypes[i]+".png' class='sessionStatsTableIcon'>";
                        dataLine.appendChild(dataElement);
                        continue;
                    }                    
                    dataElement.id = dataTypes[i]+dataMetrics[j];
                    dataElement.innerHTML = "--";
                    dataLine.appendChild(dataElement);
                }
                sessionStatTable.appendChild(dataLine);
            }
            sessionStatsBottom.appendChild(sessionStatTable);
            //session.appendChild(sessionStatsBottom);
            bleSettingsScreen.appendChild(session);   
            bleSettingsScreen.appendChild(sessionStatsBottom);         

        document.body.appendChild(bleSettingsScreen);
        this.screenEl = bleSettingsScreen;
        this.#renderScreen();
        this.#sampleLoop();
    }
    // TODO: animations?
    show(){
        if(this.screenEl != null){
            this.screenEl.style.display = "flex";
            this.renderActive = true;
        }
    }
    hide(){
        if(this.screenEl != null){
            this.screenEl.style.display = "none";
            this.renderActive = false;
        }
    }

    swapDisplayMode(){
        this.displayMode = (this.displayMode == "Total") ? "Lap" : "Total";
        document.getElementById("sessionStatTableName").innerHTML = this.displayMode;
    }

    #renderScreen(){
        setTimeout((event) => this.#renderScreen(), this.refreshRateMS);
        if (!this.renderActive) return;   

        if (this.bike.self != null){
            document.getElementById("bikeName").innerHTML = this.bike.name;
            document.getElementById("bleBike").style.backgroundColor = "#0082FC";
            document.getElementById("PowerCur").innerHTML = this.bike.power;
            document.getElementById("CadenceCur").innerHTML = Math.round(this.bike.cadence);
            document.getElementById("SpeedCur").innerHTML = Math.round(this.bike.speed*10)/10;
            document.getElementById("EnergyCur").innerHTML = Math.round(this.bike.power*0.8598452279); // W -> kCal/h

        }
        else{
            document.getElementById("bikeName").innerHTML = "Bike";
            document.getElementById("bleBike").style.backgroundColor = "black";
        }
        if (this.hr.self != null){
            document.getElementById("hrmName").innerHTML = this.hr.name;
            document.getElementById("bleHRM").style.backgroundColor = "#0082FC";
            document.getElementById("HeartRateCur").innerHTML = Math.round(this.hr.heartRate);
        }
        else{
            document.getElementById("hrmName").innerHTML = "Heart Rate Monitor";
            document.getElementById("bleHRM").style.backgroundColor = "black";
        }
        if (this.steeringWheel.self != null){
            document.getElementById("sratName").innerHTML = this.steeringWheel.name;
            document.getElementById("bleSRAT").style.backgroundColor = "#0082FC";
        }
        else{
            document.getElementById("sratName").innerHTML = "SRAT+";
            document.getElementById("bleSRAT").style.backgroundColor = "black";
        }

        if(this.sessionData.timeStart != 0){
            let dt = (this.sessionData.timeEnd ? this.sessionData.timeEnd : new Date().getTime()) - this.sessionData.timeStart;
            
            document.getElementById("bleSessionTimeTotal").innerHTML = formatTime(dt, dt < 5000);
            dt = dt-this.sessionData.laps[this.sessionData.laps.length-1];
            document.getElementById("bleSessionTimeLap").innerHTML = formatTime(dt, dt < 5000);

            if(this.sessionData.displayMode == "Total"){ // TODO: Enums

                let dtMS = this.sessionData.accumulatedTime.length ? this.sessionData.accumulatedTime[this.sessionData.accumulatedTime.length-1] : 1000;
                //Heart Rate
                if (this.sessionData.accumulatedHeartBeats.length >= 2){
                    let accHr = this.sessionData.accumulatedHeartBeats[this.sessionData.accumulatedHeartBeats.length-1] - this.sessionData.accumulatedHeartBeats[0];
                    document.getElementById("HeartRateAcc").innerHTML = Math.floor(accHr);
                    document.getElementById("HeartRateAvg").innerHTML = Math.floor(accHr/dtMS*60*1000); // converting average pr millisecond to average pr minute
                }
                if (this.sessionData.maxPulse){
                    document.getElementById("HeartRateMax").innerHTML = this.sessionData.maxPulse;
                }
                // Power & Energy
                const power2kCalh = 0.8598452279;
                const kJoule2kCal = 0.2390057361;
                const ms2h = 3600000;
                if(this.sessionData.pwr.length >= 2){
                    document.getElementById("PowerMax").innerHTML = Math.floor(this.sessionData.maxPwr); //+"W";
                    document.getElementById("EnergyMax").innerHTML = Math.floor(this.sessionData.maxPwr*power2kCalh); //+"kCal/h";
                }
                if(this.sessionData.accumulatedEnergy.length >= 2){
                    let acckJoule = this.sessionData.accumulatedEnergy[this.sessionData.accumulatedEnergy.length-1] - this.sessionData.accumulatedEnergy[0]; 
                    document.getElementById("PowerAcc").innerHTML = Math.floor(acckJoule); // + "kJ";
                    document.getElementById("EnergyAcc").innerHTML = Math.floor(acckJoule*kJoule2kCal); // + "kCal";
                    document.getElementById("PowerAvg").innerHTML = Math.floor(acckJoule/(dtMS/1000)*1000); // + "W";
                    document.getElementById("EnergyAvg").innerHTML = Math.floor(acckJoule*kJoule2kCal*ms2h/dtMS); // + "kCal/h";
                }
                // Distance & Speed
                if(this.sessionData.speed.length >= 2){
                    document.getElementById("SpeedMax").innerHTML = (Math.round(this.sessionData.maxSpeed*10)/10); //+"km/h";
                }
                if(this.sessionData.accumulatedDistance.length >= 2){
                    let accDist = this.sessionData.accumulatedDistance[this.sessionData.accumulatedDistance.length-1] - this.sessionData.accumulatedDistance[0];
                    accDist /= 1000; // m -> km
                    document.getElementById("SpeedAcc").innerHTML = Math.floor(accDist); // + "km";
                    document.getElementById("SpeedAvg").innerHTML = Math.round(accDist*ms2h/dtMS*10)/10; // + "km/h";
                }
                // Cadence
                if(this.sessionData.cadence.length >= 2){
                    // let dtMS = this.sessionData.cadence[this.sessionData.cadence.length-1][1] - this.sessionData.cadence[0][0];
                    document.getElementById("CadenceAvg").innerHTML = Math.floor(sumAllElementsSinceIndex(this.sessionData.cadence, 0)/this.sessionData.cadence.length); // + "rpm";
                    document.getElementById("CadenceMax").innerHTML = Math.floor(this.sessionData.maxCadance); // + "rpm";
                }
            
            }
            else if(this.sessionData.displayMode == "Lap"){
                let lapStartTime = this.sessionData.laps[this.sessionData.laps.length-1];
                let startIndex = this.sessionData.lapStartIndex;

                if(!this.sessionData.accumulatedTime.length) return;

                let dtMS = this.sessionData.accumulatedTime[this.sessionData.accumulatedTime.length-1] - this.sessionData.accumulatedTime[startIndex];
                dtMS = Math.max(dtMS, 1);

                // Heart Rate
                if (this.sessionData.accumulatedHeartBeats.length >= 2){
                    let accHr = this.sessionData.accumulatedHeartBeats[this.sessionData.accumulatedHeartBeats.length-1] - this.sessionData.accumulatedHeartBeats[startIndex];
                    document.getElementById("HeartRateAcc").innerHTML = Math.floor(accHr);
                    document.getElementById("HeartRateAvg").innerHTML = Math.floor(accHr/dtMS*60*1000); // converting average pr millisecond to average pr minute
                 
                }
                if (this.sessionData.maxPulse){
                    document.getElementById("HeartRateMax").innerHTML = Math.floor(findLargestElementFromTimeStamp(this.sessionData.hr, lapStartTime)[0]);
                }

                // Power & Energy
                const power2kCalh = 0.8598452279;
                const kJoule2kCal = 0.2390057361;
                const ms2h = 3600000;
                if(this.sessionData.pwr.length >= 2){
                    let maxPwr = findLargestElementFromIndex(this.sessionData.pwr, startIndex);
                    document.getElementById("PowerMax").innerHTML = Math.floor(maxPwr); //+"W";
                    document.getElementById("EnergyMax").innerHTML = Math.floor(maxPwr*power2kCalh); //+"kCal/h";
                }
                if(this.sessionData.accumulatedEnergy.length >= 2){
                    let acckJoule = this.sessionData.accumulatedEnergy[this.sessionData.accumulatedEnergy.length-1] - this.sessionData.accumulatedEnergy[startIndex];
                    document.getElementById("PowerAcc").innerHTML = Math.floor(acckJoule); // + "kJ";
                    document.getElementById("EnergyAcc").innerHTML = Math.floor(acckJoule*kJoule2kCal); // + "kCal";
                    document.getElementById("PowerAvg").innerHTML = Math.floor(acckJoule/(dtMS/1000)*1000); // + "W";
                    document.getElementById("EnergyAvg").innerHTML = Math.floor(acckJoule*kJoule2kCal*ms2h/dtMS); // + "kCal/h";
                }
                // Distance & Speed
                if(this.sessionData.speed.length >= 2){
                    document.getElementById("SpeedMax").innerHTML = (Math.round(findLargestElementFromIndex(this.sessionData.speed, startIndex)*10)/10); //+"km/h";
                }
                if(this.sessionData.accumulatedDistance.length >= 2){
                    let accDist = this.sessionData.accumulatedDistance[this.sessionData.accumulatedDistance.length-1] - this.sessionData.accumulatedDistance[startIndex];
                    accDist /= 1000; // m -> km
                    document.getElementById("SpeedAcc").innerHTML = Math.floor(accDist); // + "km";
                    document.getElementById("SpeedAvg").innerHTML = Math.round(accDist*ms2h/dtMS*10)/10; // + "km/h";
                }
                // Cadence
                if(this.sessionData.cadence.length >= 2){
                    // let dtMS = this.sessionData.cadence[this.sessionData.cadence.length-1][1] - this.sessionData.cadence[0][0];
                    document.getElementById("CadenceAvg").innerHTML = Math.floor(sumAllElementsSinceIndex(this.sessionData.cadence, startIndex)/((this.sessionData.cadence.length - startIndex))); // + "rpm"; // TODO: FIX: find index of timestamp 
                    document.getElementById("CadenceMax").innerHTML = Math.floor(findLargestElementFromIndex(this.sessionData.cadence, startIndex)); // + "rpm";
                }
            }
        }
        else{
            // Default Screen
            document.getElementById("bleSessionTimeTotal").innerHTML = formatTime(0, true);
            document.getElementById("bleSessionTimeLap").innerHTML = formatTime(0, true);

            const L1 = ["HeartRate", "Power", "Cadence", "Speed", "Energy"];
            const L2 = ["Acc", "Avg", "Max"];

            for(var i = 0; i < L1.length; i++){
                for(var j = 0; j < L2.length; j++){
                    document.getElementById(L1[i]+L2[j]).innerHTML = "--";
                }
            }
        }
    }
    #sampleLoop(loop = true){
        if (loop) {
            setTimeout((event) => this.#sampleLoop(), this.sampleRateMS);
        }        
        
        let now = new Date().getTime();

        let hr = null;
        let accHr = null;

        if(this.hr.self != null){
            hr = this.hr.heartRate;
            accHr = this.hr.accumulatedHeartBeats;
        }

        if(this.bike.self != null && this.bike.lastNotificationTimeStamp != this.lastSampleTS.bike){
            this.sessionData.sample(
                this.bike.power,
                this.bike.cadence,
                this.bike.speed,
                this.bike.accumulatedDistance,
                this.bike.accumulatedEnergy,
                hr,
                accHr
            );
            this.lastSampleTS.bike = this.bike.lastNotificationTimeStamp;
        }     
        
        const WatchDogTimeout = {bike: 60*1000, hr: 6*1000}
        if (this.bike.lastNotificationTimeStamp && now > this.bike.lastNotificationTimeStamp + WatchDogTimeout.bike) this.bike.onDisconnected();
        if (this.hr.lastNotificationTimeStamp && now > this.hr.lastNotificationTimeStamp + WatchDogTimeout.hr) this.hr.onDisconnected();
    }
}

//////////////////////////////
///    Helper functions    ///
//////////////////////////////

function clickConenct(event, device){
    device.connect();
}

function clickSessionHandler(event, sessionData, action){
    switch(action){
        case SESSION_ACTIONS.START:
            sessionData.start();
            document.getElementById("bleSessionStart").style.display = "none";
            document.getElementById("bleSessionLap").style.display = "flex";
            document.getElementById("bleSessionStop").style.display = "flex";
            break;
        case SESSION_ACTIONS.LAP:
            sessionData.lap();
            break;
        case SESSION_ACTIONS.STOP:
            sessionData.stop();
            document.getElementById("bleSessionLap").style.display = "none";
            document.getElementById("bleSessionStop").style.display = "none";
            //document.getElementById("bleSessionSave").style.display = "flex";
            document.getElementById("bleSessionRestart").style.display = "flex";
            document.getElementById("bleSessionDownload").style.display = "flex";
            break;
        case SESSION_ACTIONS.SAVE:
            // TODO
            // if DB available -> save to db and promt user [alert("Saved to cloud");]
            // else -> save to browser [alert("Saved locally in browser. The browser can only store one session at the time, this file will be overwritten next time you save a session")];
            break;
        case SESSION_ACTIONS.DOWNLOAD:
            console.log("Downloading...");
            downloadTCX(sessionData);
            break;
        case SESSION_ACTIONS.RESTART:
            sessionData.restart();
            document.getElementById("bleSessionSave").style.display = "none";
            document.getElementById("bleSessionDownload").style.display = "none";
            document.getElementById("bleSessionRestart").style.display = "none";
            document.getElementById("bleSessionStart").style.display = "flex";
    }
}


function convertTo16BitArray(x){
    // index 0 is LSB 
    if ( x < 0  || x >= Math.pow(2, 16)) { return []; }
    let returnArray = []
    for(let i = 15; i >= 0; i--){
        let dec = Math.pow(2, i);
        if(dec <= x){
            x -= dec;
            returnArray.unshift(1);
        }
        else{
            returnArray.unshift(0);
        }
    }
    return returnArray;
}

function formatTime(ms, displayMS = false){
    var isNegative = ms < 0;
    ms = Math.abs(ms);
    let h = 60*60*1000;
    let m = 60*1000;
    let s = 1000;
    var hours = Math.floor(ms/h);
    ms -= hours*h;
    var minutes = Math.floor(ms/m);
    ms -= minutes*m;
    var seconds = Math.floor(ms/s);
    ms -= seconds*s;
    if (hours < 10) hours = "0"+hours;
    if (minutes < 10) minutes = "0"+minutes;
    if (seconds < 10) seconds = "0"+seconds;
    
    let time = (isNegative?"- ":"")+hours+":"+minutes+":"+seconds;
    if (displayMS) {
        if (ms < 10){
            ms = "00"+ms;
        } 
        else if(ms < 100){
            ms = "0"+ms;
        }
        else{
            ms = ""+ms;
        }
        time += "."+ms[0]+ms[1];
    }
    return time;
}

function findLargestElementFromIndex(elements, startIndex) {
    let largestElement = 0;
    for(var i = startIndex; i < elements.length; i++){
        if(elements[i] && elements[i] > largestElement) largestElement = elements[i];
    }
    return largestElement;
}
function findClosestIndex(timeVector, timeStamp){
    let i = 0;
    for(i = 0; i < timeVector.length; i++){
        if(timeVector[i] == timeStamp) return i;
        if(timeVector[i] > timeStamp) return Math.abs(timeVector[i-1] - timeStamp) < Math.abs(timeVector[i][1] - timeStamp) ? i-1 : i;
    }
    return i;
}

function sumAllElementsSinceIndex(elements, startIndex){
    let sum = 0;
    for(var i = startIndex; i < elements.length; i++){
        if(elements[i] != null){
            sum += elements[i];
        }
    }
    return sum;
}


function bluetooth_available(){
    return navigator.bluetooth;
}

function convertTimestampToISOString(timestamp) {
    const date = new Date(timestamp); // Create a Date object from the timestamp
    const isoString = date.toISOString(); // Get the ISO string (e.g., '2023-10-15T12:00:00.000Z')
    return isoString.slice(0, 19) + 'Z'; // Remove milliseconds and return the formatted string
}

function downloadTCX(sessionData){
    if (!(sessionData instanceof SessionData)) {
        throw new Error(`Expected an instance of ${SessionData.name}, but received ${sessionData.constructor.name}`);
    }

    // If there are no datapoint return before download
    if(!sessionData.accumulatedTime.length) return;

    // START A TCX FILE CONTAINING THE SESSION
    let tcxData = `<?xml version="1.0" encoding="UTF-8"?>
    <TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
        <Activities>
            <Activity Sport="Biking">
                <Id>`+convertTimestampToISOString(sessionData.timeStart)+`</Id>`;
    
    // LOOP OVER ALL LAPS
    let trackpointIndex = 0; // Global index of all the sample points
    for(var i = 0; i < sessionData.laps.length; i++){
        // TODO: handle null events
        const dtStart = sessionData.laps[i];
        const dtEnd = i < sessionData.laps.length-1 ? sessionData.laps[i+1] : sessionData.timeEnd - sessionData.timeStart;
        
        const startTime = sessionData.timeStart + dtStart;
        const endTime = (i < sessionData.laps.length-1) ? startTime+sessionData.laps[i+1] : sessionData.timeEnd;    
        const lapTimeSeconds = Math.round((endTime - startTime)/1000);

        const startIndex = trackpointIndex;
        const endIndex = i < sessionData.laps.length-1 ? findClosestIndex(sessionData.accumulatedTime, dtEnd): sessionData.accumulatedTime.length-1;

        const startDistance = sessionData.accumulatedDistance[startIndex];
        const endDistance = sessionData.accumulatedDistance[endIndex];
        const distance = Math.round((endDistance-startDistance));

        const startEnergy = sessionData.accumulatedEnergy[startIndex];
        const endEnergy = sessionData.accumulatedEnergy[endIndex];

        const calories = Math.round((endEnergy-startEnergy)*0.2390057361); // kJoule to kCal convertion

        // START A LAP CONSISTING OF A TRACK
        let lap = `<Lap StartTime="`+convertTimestampToISOString(startTime)+`">
                    <TotalTimeSeconds>`+lapTimeSeconds+`</TotalTimeSeconds>
                    <DistanceMeters>`+distance+`</DistanceMeters>
                    <Calories>`+calories+`</Calories>
                    <Track>`;

        // ADD ALL TRACK POINTS
        let dt = sessionData.accumulatedTime[trackpointIndex];
        while(dt <= dtEnd){            
            let trackpoint = `<Trackpoint>
                <Time>`+convertTimestampToISOString(startTime+dt)+`</Time>`;
            
            // CONSIDER: implementing
            // if (false){ 
            //     trackpoint += `<AltitudeMeters>0</AltitudeMeters>`;
            // }

            if(sessionData.hr[trackpointIndex] != null){
                trackpoint += `<HeartRateBpm>`+Math.round(sessionData.hr[trackpointIndex])+`</HeartRateBpm>`;
            }
            if(sessionData.accumulatedDistance[trackpointIndex] != null){
                let trpt_distance = Math.floor((sessionData.accumulatedDistance[trackpointIndex]-startDistance));
                trackpoint += `<DistanceMeters>`+trpt_distance+`</DistanceMeters>`;
            }
            if(sessionData.cadence[trackpointIndex] != null){
                trackpoint += `<Cadence>`+Math.round(sessionData.cadence[trackpointIndex])+`</Cadence>`;
            }
            if(sessionData.pwr[trackpointIndex] != null){
                trackpoint += `<Watts>`+Math.round(sessionData.pwr[trackpointIndex])+`</Watts>`;
            }
            
            trackpoint += `</Trackpoint>`;
            lap += trackpoint;

            // Iterate
            trackpointIndex++;            
            if(trackpointIndex > sessionData.accumulatedTime.length) {
                console.error("Download data corrupted");
                break; // Something has gone wrong at this point [Should never happen]
            }
            dt = sessionData.accumulatedTime[trackpointIndex];            
        }

        // END OF LAP
        lap += `</Track></Lap>`;
        // ADD LAP TO SESSION
        tcxData += lap;
    }
    // END OF SESSION
    tcxData += `</Activity></Activities></TrainingCenterDatabase>`;
    
    const blob = new Blob([tcxData], { type: 'application/xml' });
    // Create a download link
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'activity.tcx'; // File name
    document.body.appendChild(a);
    a.click();

    // Cleanup
    window.URL.revokeObjectURL(url);
}