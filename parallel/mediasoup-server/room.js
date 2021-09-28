const mediasoup = require('mediasoup');
const config = require('../../config');

class Room {

    /**
     * 
     * @param {*} param0
     * @param {string} param0.roomId
     * @param {object} param0.mediasoupRouter
     */
    constructor({ roomId, mediasoupRouter }) {
        this._roomId = roomId;
        this._mediasoupRouter = mediasoupRouter;

        /**
         * @typedef {object} Broadcaster
         * @property {string} id
         * @property {object} data
         * @property {RTCRtpCapabilities} data.rtpCapabilities
         * @property {Map<String, mediasoup.Transport>} data.transports
         * @property {Map<String, mediasoup.Producer>} data.producers
         * @property {Map<String, mediasoup.Consumers>} data.consumers
         */
        /**
         * Map of Broadcaster
         * @type {Map<String, Broadcaster>}
         */
		this._broadcasters = new Map();
    }

    
    getRouterRtpCapabilities() {
        return this._mediasoupRouter.rtpCapabilities;
    }


    /**
	 * Create a Broadcaster. This is for HTTP API requests (see server.js).
	 *
	 * @async
	 *
	 * @property {object} payload
     * @property {string} payload.id - Broadcaster id.
     * @property {RTCRtpCapabilities} payload.rtpCapabilities - Device RTP capabilities.
	 */
    createBroadcaster({ id, rtpCapabilities }) {
        if (typeof id !== 'string' || !id)
			throw new TypeError('missing body.id');
        else if (rtpCapabilities && typeof rtpCapabilities !== 'object')
			throw new TypeError('wrong body.rtpCapabilities');

        if (this._broadcasters.has(id))
			throw new Error(`broadcaster with id "${id}" already exists`);

        const broadcaster = {
            id,
			data: {
                rtpCapabilities,
				transports    : new Map(),
				producers     : new Map(),
				consumers     : new Map(),
			},
        };
        this._broadcasters.set(id, broadcaster);
    }

    /**
	 * Delete a Broadcaster.
	 *
	 * @property {String} condition
     * @property {string} condition.broadcasterId
	 */
	deleteBroadcaster({ broadcasterId })
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		for (const transport of broadcaster.data.transports.values())
		{
			transport.close();
		}

		this._broadcasters.delete(broadcasterId);
	}

    /**
	 * Create a mediasoup Transport associated to a Broadcaster. It can be a
	 * PlainTransport or a WebRtcTransport.
	 *
	 * @async
	 *
     * @property {object} payload
     * @property {string} payload.broadcasterId
     * @property {string} payload.type Can be 'plain' (PlainTransport) or 'webrtc'(WebRtcTransport)
	 */
	async createBroadcasterTransport(
		{
			broadcasterId,
			type,
		})
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		switch (type)
		{
			case 'webrtc': 
            {
                const {
                    maxIncomingBitrate,
                    initialAvailableOutgoingBitrate
                } = config.mediasoup.webRtcTransport;
                
                const transport = await this._mediasoupRouter.createWebRtcTransport({
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

                broadcaster.data.transports.set(transport.id, transport);
            
                return {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters
                };
			}

            case 'plain': 
            {
                throw new Error('the plain type is not implements');
            }

			default:
			{
				throw new TypeError('invalid type');
			}
		}
	}

    /**
	 * Connect a Broadcaster mediasoup WebRtcTransport.
	 *
	 * @async
	 * 
     * @property {object} payload
	 * @property {String} payload.broadcasterId
	 * @property {String} payload.transportId
	 * @property {RTCDtlsParameters} payload.dtlsParameters - Remote DTLS parameters.
	 */
	async connectBroadcasterTransport(
		{
			broadcasterId,
			transportId,
			dtlsParameters
		}
	)
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		const transport = broadcaster.data.transports.get(transportId);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		if (transport.constructor.name !== 'WebRtcTransport')
		{
			throw new Error(
				`transport with id "${transportId}" is not a WebRtcTransport`);
		}

		await transport.connect({ dtlsParameters });
	}

    /**
	 * Create a mediasoup Producer associated to a Broadcaster.
	 *
	 * @async
	 *
     * @property {object} payload
	 * @property {String} payload.broadcasterId
	 * @property {String} payload.transportId
	 * @property {String} payload.kind - 'audio' or 'video' kind for the Producer.
	 * @property {RTCRtpParameters} payload.rtpParameters - RTP parameters for the Producer.
	 */
	async createBroadcasterProducer(
		{
			broadcasterId,
			transportId,
			kind,
			rtpParameters
		}
	)
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		const transport = broadcaster.data.transports.get(transportId);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		const producer =
			await transport.produce({ kind, rtpParameters });

		// Store it.
		broadcaster.data.producers.set(producer.id, producer);

		producer.on('videoorientationchange', (videoOrientation) =>
		{
			console.debug(
				'broadcaster producer "videoorientationchange" event [producerId:%s, videoOrientation:%o]',
				producer.id, videoOrientation);
		});

		producer.on('transportclose', () => {
			producer.close();
			broadcaster.data.producers.delete(producer.id);
		});

		return { id: producer.id };
	}

	/**
	 * Delete a mediasoup Producer.
	 *
	 * @async
	 *
     * @property {object} payload
	 * @property {String} payload.broadcasterId
	 * @property {String} payload.producerId
	 */
	async deleteBroadcasterProducer(
		{
			broadcasterId,
			producerId,
		}
	) 
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		const producer = broadcaster.data.producers.get(producerId);

		if (!producer)
			throw new Error(`producer with id "${producerId}" does not exist`);

		producer.close();
		broadcaster.data.producers.delete(producer.id);
	}

    /**
	 * Create a mediasoup Consumer associated to a Broadcaster.
	 *
	 * @async
	 *
     * @property {object} payload
	 * @property {String} payload.broadcasterId
	 * @property {String} payload.transportId
	 * @property {String} payload.producerId
	 */
	async createBroadcasterConsumer(
		{
			broadcasterId,
			transportId,
			producerId
		}
	)
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		if (!broadcaster.data.rtpCapabilities)
			throw new Error('broadcaster does not have rtpCapabilities');

		const transport = broadcaster.data.transports.get(transportId);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		const consumer = await transport.consume(
			{
				producerId,
				rtpCapabilities : broadcaster.data.rtpCapabilities
			});

		// Store it.
		broadcaster.data.consumers.set(consumer.id, consumer);

		// Set Consumer events.
		consumer.on('transportclose', () =>
		{
			// Remove from its map.
			consumer.close();
			broadcaster.data.consumers.delete(consumer.id);
		});

		consumer.on('producerclose', () =>
		{
			// Remove from its map.
			consumer.close();
			broadcaster.data.consumers.delete(consumer.id);
		});

		return {
			id            : consumer.id,
			producerId,
			kind          : consumer.kind,
			rtpParameters : consumer.rtpParameters,
			type          : consumer.type
		};
	}

}

module.exports = Room;