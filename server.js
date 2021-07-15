const mediasoup = require('mediasoup');
const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const config = require('./config');

// Global variables
let worker;
let webServer;
let socketServer;
let expressApp;
let mediasoupRouter;

(async () => {
  try {
    await runExpressApp();
    await runWebServer();
    await runSocketServer();
    await runMediasoupWorker();
  } catch (err) {
    console.error(err);
  }
})();

async function runExpressApp() {
  expressApp = express();
  expressApp.use(express.json());
  expressApp.use(express.static(__dirname));

  expressApp.use((error, req, res, next) => {
    if (error) {
      console.warn('Express app error,', error.message);

      error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

      res.statusMessage = error.message;
      res.status(error.status).send(String(error));
    } else {
      next();
    }
  });
}

async function runWebServer() {
  const { sslKey, sslCrt } = config;
  if (!fs.existsSync(sslKey) || !fs.existsSync(sslCrt)) {
    console.error('SSL files are not found. check your config.js file');
    process.exit(0);
  }
  const tls = {
    cert: fs.readFileSync(sslCrt),
    key: fs.readFileSync(sslKey),
  };
  webServer = https.createServer(tls, expressApp);
  webServer.on('error', (err) => {
    console.error('starting web server failed:', err.message);
  });

  await new Promise((resolve) => {
    const { listenIp, listenPort } = config;
    webServer.listen(listenPort, listenIp, () => {
      const listenIps = config.mediasoup.webRtcTransport.listenIps[0];
      const ip = listenIps.announcedIp || listenIps.ip;
      console.log('server is running');
      console.log(`open https://${ip}:${listenPort} in your web browser`);
      resolve();
    });
  });
}

async function runSocketServer() {
  socketServer = socketIO(webServer, {
    serveClient: false,
    path: '/server',
    log: false,
  });

  const presenter = {
    producerTransport: null,
    producer: null,
    socketId: null
  };

  const socketsData = new Map();
  const transports = new Map();
  const producers = new Map();
  const consumers = new Map();

  let logIndex = 1;
  const broadcastLog = (message, showToServer = true) => {
    const newMessage = `${logIndex}: ${message}`
    if (showToServer) {
      console.log(newMessage);
    }
    socketServer.emit('log', newMessage);
    logIndex++;
  }

  const broadcastUsers = () => {
    const socketIds = Array.from(socketsData.keys());
    const users = socketIds.map(socketId => {
      const availableProducerIds = 
        socketsData
          .get(socketId)
          .producerIds
          .filter(producerId => {
            const producer = producers.get(producerId);
            if (!producer) {
              return false;
            }
            return producer.customMetadata.available;
          });

      return {
        id: socketId,
        is_presenter: presenter.socketId === socketId,
        availableProducerIds: availableProducerIds,
      };
    });
    socketServer.emit('users', users);
  };
  
  socketServer.on('connection', (socket) => {
    const socketStreamData = {
      presenterConsumer: {
        transport: null,
        videoConsumer: null,
      },
      transportIds: [],
      producerIds: [],
      consumerIds: [],
    };

    broadcastLog(`client connected - ${socket.id}`)
    // binding object
    socketsData.set(socket.id, socketStreamData);

    socket.on('clientIsReady', () => {
      broadcastUsers();
      if (presenter.producer) {
        socket.emit('newPresenter');
      }
    })

    socket.on('disconnect', () => {
      // presenter clear
      if (presenter.socketId === socket.id) {
        presenter.producer.close();
        presenter.producerTransport.close();
        presenter.producerTransport = null;
        presenter.producer = null;
        presenter.socketId = null;

        socket.emit('presenterExit')
        broadcastLog(`presenter close - ${socket.id}`)
      } 

      // 
      if (socketStreamData.presenterConsumer.videoConsumer) {
        socketStreamData.presenterConsumer.videoConsumer.close();
      }
      if (socketStreamData.presenterConsumer.transport) {
        socketStreamData.presenterConsumer.transport.close();
      }

      // clear transport producers
      socketStreamData.consumerIds.forEach(id => {
        consumers.delete(id);
      });
      socketStreamData.producerIds.forEach(id => {
        producers.get(id).close();
        producers.delete(id);
      });
      socketStreamData.transportIds.forEach(id => {
        transports.get(id).close();
        transports.delete(id);
      });
      

      // unbinding object
      socketsData.delete(socket.id);
      broadcastLog(`client disconnected - ${socket.id}`)
      broadcastUsers()
    });

    socket.on('connect_error', (err) => {
      console.error('client connection error', err);
    });

    socket.on('getRouterRtpCapabilities', (data, callback) => {
      callback(mediasoupRouter.rtpCapabilities);
    });

    // presenter

    socket.on('createPresenterProducerTransport', async (data,callback) => {
      try {
        const { transport, params } = await createWebRtcTransport();
        presenter.socketId = socket.id;
        presenter.producerTransport = transport;
        callback(params);
      } catch (err) {
        console.error('createPresenterProducerTransport error', err);
        callback({ error: err.message });
      }
    });
    socket.on('connectPresenterProducerTransport', async (data, callback) => {
      try {
        await presenter.producerTransport.connect({ dtlsParameters: data.dtlsParameters });
        callback();
      }
      catch(error) {
        callback({ error: err.message });
      }
    });
    socket.on('presenterProduce', async (data, callback) => {
      try {
        const {kind, rtpParameters} = data;
        presenter.producer = await presenter.producerTransport.produce({ kind, rtpParameters });
        callback({ id: presenter.producer.id });
  
        socketServer.emit('newPresenter');
        broadcastUsers();
        broadcastLog(`new presenter - ${socket.id}`)
      } catch(error) {
        console.error(error)
      }
      
    });
    socket.on('createPresenterConsumerTransport', async (data,callback) => {
      try {
        const { transport, params } = await createWebRtcTransport();
        socketStreamData.presenterConsumer.transport = transport;
        callback(params);
      } catch (err) {
        console.error('createPresenterConsumerTransport error', err);
        callback({ error: err.message });
      }
    });
    socket.on('connectPresenterConsumerTransport', async (data, callback) => {
      await socketStreamData.presenterConsumer.transport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });
    socket.on('consumePresenter', async (data, callback) => {
      const {rtpCapabilities} = data;
      const producer = presenter.producer;

      if (!mediasoupRouter.canConsume(
        {
          producerId: producer.id,
          rtpCapabilities: rtpCapabilities,
        })
      ) {
        console.error('can not consume');
        return callback();
      }

      try {
        socketStreamData.presenterConsumer.videoConsumer = await socketStreamData.presenterConsumer.transport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: producer.kind === 'video',
        });
      } catch (error) {
        console.error('consume failed', error);
        return;
      }

      const result = {
        producerId: producer.id,
        id: socketStreamData.presenterConsumer.videoConsumer.id,
        kind: socketStreamData.presenterConsumer.videoConsumer.kind,
        rtpParameters: socketStreamData.presenterConsumer.videoConsumer.rtpParameters,
        type: socketStreamData.presenterConsumer.videoConsumer.type,
        producerPaused: socketStreamData.presenterConsumer.videoConsumer.producerPaused
      };
      await socketStreamData.presenterConsumer.videoConsumer.resume();

      callback(result);
    });

    // each room of users
    socket.on('createVideoAndAudioTransport', async (data, callback) => {
      try {
        const { transport, params } = await createWebRtcTransport();
        transports.set(params.id, transport);
        socketStreamData.transportIds.push(params.id);
        callback(params);
      } catch (err) {
        console.error(error)
        callback({ error: err.message });
      }
    });
    
    socket.on('connectVideoAndAudioTransport', (data, callback) => {
      const { transportId, dtlsParameters } = data;
      const transport = transports.get(transportId);
      if (!transport) {
        callback({ error: new Error('no transport') });
        return;
      }
      
      transport.connect({ dtlsParameters })
        .then(() => {
          callback();
        })
        .catch((error) => {
          console.error(error)
          callback({ error });
        });
    });

    socket.on('produceVideoAndAudio', async (data, callback) => {
      const {
        transportId,
        kind, 
        rtpParameters,
      } = data;
      const transport = transports.get(transportId);
      if (!transport) {
        callback({ error: new Error('no transport') });
        return;
      }

      try {
        const producer = await transport.produce({
          kind, 
          rtpParameters,
        });
        producers.set(producer.id, producer);
        producer.customMetadata = {
          available: false,
        };
        socketStreamData.producerIds.push(producer.id);
        console.log(`new producer ${producer.id}`);
        callback({ id: producer.id });
      } catch(error) {
        console.error(error)
        callback({ error });
      }
    });

    socket.on('deleteProduce', (data, callback) => {
      const { producerId } = data; 
      const producer = producers.get(producerId);
      if (!producer) {
        callback({ error: new Error('producer not found')});
        return;
      }
      
      const index = socketStreamData.producerIds.indexOf(producerId);
      if (index > -1) {
        socketStreamData.producerIds.splice(index, 1);
      }
      producer.close();
      producers.delete(producerId);
      
      broadcastUsers();
      callback();
    });

    socket.on('produceVideoAndAudioFinish', async(data, callback) => {
      const { producerId } = data; 
      const producer = producers.get(producerId);
      if (!producer) {
        callback({ error: new Error('producer not found')});
        return;
      }

      producer.customMetadata.available = true;
      broadcastUsers();
      callback();
    });

    socket.on('consumeVideoAndAudio',  async (data, callback) => {
      const { transportId, producerId, rtpCapabilities } = data;

      if (!mediasoupRouter.canConsume(
        {
          producerId: producerId,
          rtpCapabilities: rtpCapabilities,
        })
      ) {
        console.error('can not consume');
        return callback({ error: new Error('can not consume')});
      }

      const producer = producers.get(producerId);
      const transport = transports.get(transportId);
      if (!transport) {
        console.error('can not find transport');
        return callback({ error: new Error('can not find transport')});
      }

      try {
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: producer.kind === 'video',
        });
        consumers.set(consumer.id, consumers);
        socketStreamData.consumerIds.push(consumer.id);
        await consumer.resume();
        const result = {
          producerId: producerId,
          id: consumer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          type: consumer.type,
          producerPaused: consumer.producerPaused
        };
        callback(result);
      } catch (error) {
        console.error('consume failed', error);
        return callback({ error });
      }
    });
  });
}

async function runMediasoupWorker() {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  mediasoupRouter = await worker.createRouter({ mediaCodecs });
}

async function createWebRtcTransport() {
  const {
    maxIncomingBitrate,
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport;

  const transport = await mediasoupRouter.createWebRtcTransport({
    listenIps: config.mediasoup.webRtcTransport.listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate,
  });
  if (maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(maxIncomingBitrate);
    } catch (error) {
    }
  }
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    },
  };
}