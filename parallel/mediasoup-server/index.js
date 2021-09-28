const mediasoup = require('mediasoup');
const express = require('express');
const config = require('../../config');
const Room = require('./room');

// mediasoup Workers.
// @type {Array<mediasoup.Worker>}
/**
 * mediasoup Workers.
 * @type {Array<mediasoup.Worker}
 */
const mediasoupWorkers = [];

/*
 * Index of next mediasoup Worker to use.
 * @type {Number}
 */
let nextMediasoupWorkerIdx = 0;

/**
 * Map of Room instances indexed by roomId.
 * @type {Map<Number, Room>}
 */
const rooms = new Map();

function getRoom(roomId) {
    return rooms.get(roomId) || null;
}

async function getOrCreateRoom(roomId) {
    let room = rooms.get(roomId);
    if (room) {
        return room;
    }
    const { mediaCodecs } = config.mediasoup.router;
    const worker = getMediasoupWorker();
    const mediasoupRouter = await worker.createRouter({ mediaCodecs });
    room = new Room({
        roomId,
        mediasoupRouter,
    });

    rooms.set(roomId, room);

    return room;
}

function getRoomMiddleware(req, res, next) {
    const room = getRoom(req.params.roomId);
    if (!room) 
        return next(new Error('no room'))

    req.params.room = room;

    next();
}

const wrap = fn => (req, res, next) => {
    fn(req, res, next)
        .then(data => {
            res.json(data);
        })
        .catch(error => {
            next(error);
        });
};

(async () => {
  try {
    await runMediasoupWorkers();
    await runExpressApp();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();

async function runExpressApp() {
    const expressApp = express();
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


    expressApp.get(
        '/rooms/:roomId', 
        wrap(async (req) => {
            const room = await getOrCreateRoom(req.params.roomId);
            return room.getRouterRtpCapabilities();
        }),
    );

    expressApp.post(
        '/rooms/:roomId/broadcasters', 
        wrap(async(req) => {
            const {
				id,
                rtpCapabilities,
			} = req.body;
            const room = await getOrCreateRoom(req.params.roomId);
            await room.createBroadcaster({ id, rtpCapabilities });
            return {
                result: true,
                id,
            };
        }),
    );

    expressApp.delete(
        '/rooms/:roomId/broadcasters/:broadcasterId',
        [
            getRoomMiddleware,
        ],
        wrap(async(req) => {
            const {
                broadcasterId,
            } = req.params;
            /**
            * @type {Room}
            */
            const room = req.params.room;
            room.deleteBroadcaster({broadcasterId});
            return {
                result: true,
                broadcasterId,
            }
        }),
    );

    expressApp.post(
        '/rooms/:roomId/broadcasters/:broadcasterId/transports',
        [
            getRoomMiddleware,
        ],
        wrap(async(req) => {
            const {
                broadcasterId,
            } = req.params;
            /**
            * @type {Room}
            */
            const room = req.params.room;
            const data = await room.createBroadcasterTransport({
                broadcasterId,
                type: 'webrtc'
            });
            return data;
        }),
    );

    expressApp.post(
        '/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/connect', 
        [
            getRoomMiddleware,
        ],
        wrap(async(req) => {
            const { broadcasterId, transportId } = req.params;
			const { dtlsParameters } = req.body;
            /**
            * @type {Room}
            */
            const room = req.params.room;

            await room.connectBroadcasterTransport({
                broadcasterId,
                transportId,
                dtlsParameters
            });

            return {
                result: true,
            }
        }),
    );

    expressApp.post(
        '/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/producers', 
        [
            getRoomMiddleware,
        ],
        wrap(async(req) => {
            const { broadcasterId, transportId } = req.params;
			const { kind, rtpParameters } = req.body;

            /**
            * @type {Room}
            */
            const room = req.params.room;

            const data = await room.createBroadcasterProducer(
                {
                    broadcasterId,
                    transportId,
                    kind,
                    rtpParameters
                });

            return data;
        }),
    );

    expressApp.post(
        '/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/consume', 
        [
            getRoomMiddleware,
        ],
        wrap(async(req) => {
            const { broadcasterId, transportId } = req.params;
			const { producerId } = req.body;

             /**
            * @type {Room}
            */
              const room = req.params.room;

            const data = await room.createBroadcasterConsumer(
                {
                    broadcasterId,
                    transportId,
                    producerId
                });

            return data;			
        }),
    );

    const port = 8000;
    expressApp.listen(port, () => {
        console.log(`listen port ${8000}`)
    });
}

/**
 * Launch as many mediasoup Workers as given in the configuration file.
 */
 async function runMediasoupWorkers()
 {
     const { numWorkers } = config.mediasoup;
 
     console.info('running %d mediasoup Workers...', numWorkers);
 
     for (let i = 0; i < numWorkers; ++i)
     {
         const worker = await mediasoup.createWorker(
             {
                 logLevel   : config.mediasoup.worker.logLevel,
                 logTags    : config.mediasoup.worker.logTags,
                 rtcMinPort : Number(config.mediasoup.worker.rtcMinPort),
                 rtcMaxPort : Number(config.mediasoup.worker.rtcMaxPort)
             });
 
         worker.on('died', () =>
         {
             console.error(
                 'mediasoup Worker died, exiting  in 2 seconds... [pid:%d]', worker.pid);
 
             setTimeout(() => process.exit(1), 2000);
         });
 
         mediasoupWorkers.push(worker);
 
         // Log worker resource usage every X seconds.
         setInterval(async () =>
         {
             const usage = await worker.getResourceUsage();
 
             logger.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);
         }, 120000);
     }
 }

/**
 * Get next mediasoup Worker.
 */
 function getMediasoupWorker()
 {
     const worker = mediasoupWorkers[nextMediasoupWorkerIdx];
 
     if (++nextMediasoupWorkerIdx === mediasoupWorkers.length)
         nextMediasoupWorkerIdx = 0;
 
     return worker;
 }