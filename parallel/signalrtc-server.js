const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const config = require('../config');

const APICaller = require('./API');
const rtcAPI = new APICaller('http://localhost:8000');

// Global variables
let webServer;
let socketServer;
let expressApp;

(async () => {
  try {
    await runExpressApp();
    await runWebServer();
    await runSocketServer();
  } catch (err) {
    console.error(err);
  }
})();

async function runExpressApp() {
  expressApp = express();
  expressApp.use(express.json());
  expressApp.use(express.static(__dirname + '/web'));

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
    transportId: null,
    producerId: null,
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
        transportId: null,
        videoConsumerId: null,
      },
      transportIds: [],
      producerIds: [],
      consumerIds: [],
    };
    let isHasBroadcaster = false;

    broadcastLog(`client connected - ${socket.id}`)
    // binding object
    socketsData.set(socket.id, socketStreamData);

    socket.on('clientIsReady', () => {
      broadcastUsers();
      if (presenter.producer) {
        socket.emit('newPresenter', presenter.socketId);
      }
    })

    socket.on('disconnect', () => {
      // presenter clear
      if (presenter.socketId === socket.id) {
        presenter.transportId = null;
        presenter.producer = null;
        presenter.socketId = null;

        socket.emit('presenterExit')
        broadcastLog(`presenter close - ${socket.id}`)
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

      if (isHasBroadcaster) {
        rtcAPI.delete(`rooms/1/broadcasters/${socket.id}`)
          .catch(error=>console.error(error));
      }
      
      // unbinding object
      socketsData.delete(socket.id);
      broadcastLog(`client disconnected - ${socket.id}`)
      broadcastUsers()
    });

    socket.on('connect_error', (err) => {
      console.error('client connection error', err);
    });

    socket.on('getRouterRtpCapabilities', async(data, callback) => {
      const rtpCapabilities = await rtcAPI.get('rooms/1');
      await rtcAPI.post('rooms/1/broadcasters', {
        id: socket.id,
        rtpCapabilities,
      });
      isHasBroadcaster = true;
      callback(rtpCapabilities);
    });

    // presenter

    socket.on('createPresenterProducerTransport', async (data,callback) => {
      try {
        const params = await rtcAPI.post(`rooms/1/broadcasters/${socket.id}/transports`);
        presenter.transportId = params.id;
        presenter.socketId = socket.id;

        callback(params);
      } catch (err) {
        console.error('createPresenterProducerTransport error', err);
        callback({ error: err.message });
      }
    });
    socket.on('connectPresenterProducerTransport', async (data, callback) => {
      try {
        await rtcAPI.post(`rooms/1/broadcasters/${socket.id}/transports/${presenter.transportId}/connect`, {
          dtlsParameters: data.dtlsParameters,
        });
        callback();
      }
      catch(error) {
        callback({ error: err.message });
      }
    });
    socket.on('presenterProduce', async (data, callback) => {
      try {
        const {kind, rtpParameters} = data;
        const { id: producerId } = await rtcAPI.post(`rooms/1/broadcasters/${socket.id}/transports/${presenter.transportId}/producers`, {
          kind, 
          rtpParameters,
        });
        presenter.producerId = producerId;
        callback({ id: producerId });
  
        socketServer.emit('newPresenter', presenter.socketId);
        broadcastUsers();
        broadcastLog(`new presenter - ${socket.id}`)
      } catch(error) {
        console.error(error)
      }
    });

    socket.on('closePresenter', async (data, callback) => {
      if (presenter.socketId !== socket.id) {
        callback({ error: new Error('not presenter') });
        return;
      }

      const { id: producerId } = await rtcAPI.post(`rooms/1/broadcasters/${socket.id}/transports/${presenter.transportId}/producers`, {
        kind, 
        rtpParameters,
      });

      presenter.transportId = null;
      presenter.producerId = null;
      presenter.socketId = null;

      socketServer.emit('closePresenter', socket.id);
      broadcastUsers();
      broadcastLog(`close presenter - ${socket.id}`)

      callback();
    });

    socket.on('createPresenterConsumerTransport', async (data,callback) => {
      try {
        const params = await rtcAPI.post(`rooms/1/broadcasters/${socket.id}/transports`);
        socketStreamData.presenterConsumer.transportId = params.id;
        callback(params);
      } catch (err) {
        console.error('createPresenterConsumerTransport error', err);
        callback({ error: err.message });
      }
    });
    socket.on('connectPresenterConsumerTransport', async (data, callback) => {
      try {
        const transportId = socketStreamData.presenterConsumer.transportId;
        await rtcAPI.post(`rooms/1/broadcasters/${socket.id}/transports/${transportId}/connect`, {
          dtlsParameters: data.dtlsParameters,
        });
        callback();
      }
      catch(error) {
        callback({ error: err.message });
      }
    });

    socket.on('consumePresenter', async (data, callback) => {
      const transportId = socketStreamData.presenterConsumer.transportId;
      const producerId = presenter.producerId;
      console.log(producerId)
      const result = await rtcAPI.post(`rooms/1/broadcasters/${socket.id}/transports/${transportId}/consume`, {
        producerId,
      });
      socketStreamData.presenterConsumer.videoConsumerId = result.id;
      callback(result);
    });

    // // each room of users
    // socket.on('createVideoAndAudioTransport', async (data, callback) => {
    //   try {
    //     const { transport, params } = await createWebRtcTransport();
    //     transports.set(params.id, transport);
    //     socketStreamData.transportIds.push(params.id);
    //     callback(params);
    //   } catch (err) {
    //     console.error(error)
    //     callback({ error: err.message });
    //   }
    // });
    
    // socket.on('connectVideoAndAudioTransport', (data, callback) => {
    //   const { transportId, dtlsParameters } = data;
    //   const transport = transports.get(transportId);
    //   if (!transport) {
    //     callback({ error: new Error('no transport') });
    //     return;
    //   }
      
    //   transport.connect({ dtlsParameters })
    //     .then(() => {
    //       callback();
    //     })
    //     .catch((error) => {
    //       console.error(error)
    //       callback({ error });
    //     });
    // });

    // socket.on('produceVideoAndAudio', async (data, callback) => {
    //   const {
    //     transportId,
    //     kind, 
    //     rtpParameters,
    //   } = data;
    //   const transport = transports.get(transportId);
    //   if (!transport) {
    //     callback({ error: new Error('no transport') });
    //     return;
    //   }

    //   try {
    //     const producer = await transport.produce({
    //       kind, 
    //       rtpParameters,
    //     });
    //     producers.set(producer.id, producer);
    //     producer.customMetadata = {
    //       available: false,
    //     };
    //     socketStreamData.producerIds.push(producer.id);
    //     console.log(`new producer ${producer.id}`);
    //     callback({ id: producer.id });
    //   } catch(error) {
    //     console.error(error)
    //     callback({ error });
    //   }
    // });

    // socket.on('deleteProduce', (data, callback) => {
    //   const { producerId } = data; 
    //   const producer = producers.get(producerId);
    //   if (!producer) {
    //     callback({ error: new Error('producer not found')});
    //     return;
    //   }
      
    //   const index = socketStreamData.producerIds.indexOf(producerId);
    //   if (index > -1) {
    //     socketStreamData.producerIds.splice(index, 1);
    //   }
    //   producer.close();
    //   producers.delete(producerId);
      
    //   broadcastUsers();
    //   callback();
    // });

    // socket.on('produceVideoAndAudioFinish', async(data, callback) => {
    //   const { producerId } = data; 
    //   const producer = producers.get(producerId);
    //   if (!producer) {
    //     callback({ error: new Error('producer not found')});
    //     return;
    //   }

    //   producer.customMetadata.available = true;
    //   broadcastUsers();
    //   callback();
    // });

    // socket.on('consumeVideoAndAudio',  async (data, callback) => {
    //   const { transportId, producerId, rtpCapabilities } = data;

    //   if (!mediasoupRouter.canConsume(
    //     {
    //       producerId: producerId,
    //       rtpCapabilities: rtpCapabilities,
    //     })
    //   ) {
    //     console.error('can not consume');
    //     return callback({ error: new Error('can not consume')});
    //   }

    //   const producer = producers.get(producerId);
    //   const transport = transports.get(transportId);
    //   if (!transport) {
    //     console.error('can not find transport');
    //     return callback({ error: new Error('can not find transport')});
    //   }

    //   try {
    //     const consumer = await transport.consume({
    //       producerId,
    //       rtpCapabilities,
    //       paused: producer.kind === 'video',
    //     });
    //     consumers.set(consumer.id, consumers);
    //     socketStreamData.consumerIds.push(consumer.id);
    //     await consumer.resume();
    //     const result = {
    //       producerId: producerId,
    //       id: consumer.id,
    //       kind: consumer.kind,
    //       rtpParameters: consumer.rtpParameters,
    //       type: consumer.type,
    //       producerPaused: consumer.producerPaused
    //     };
    //     callback(result);
    //   } catch (error) {
    //     console.error('consume failed', error);
    //     return callback({ error });
    //   }
    // });
    
    socket.on('message', (data, callback) => {
      socketServer.emit('message', {
        id: socket.id,
        ...data,
      });
    })
  });
}