const mediasoup = require('mediasoup-client');
const socketClient = require('socket.io-client');
const socketPromise = require('./lib/socket.io-promise').promise;
const config = require('./config');

const hostname = window.location.hostname;

let device;
let socket;

let sendTransport;
let receviceTransport;

const voiceConsumers = new Map();

const $ = document.querySelector.bind(document);
const $logBox = $('#log_box');
const $userBox = $('#user_box');
const $messageBox = $('#message_box');
const $btnConnect = $('#btn_connect');
const $btnScreen = $('#btn_screen');
const $btnVoice = $('#btn_voice');
const $btnMessage = $('#btn_message');
const $chkSimulcast = $('#chk_simulcast');
const $txtConnection = $('#connection_status');
const $txtScreen = $('#screen_status');
const $txtVoice = $('#voice_status');
const $inputMessage = $('#inputMessage');

$btnConnect.addEventListener('click', connect);
$btnScreen.addEventListener('click', publishScreenShare);
$btnVoice.addEventListener('click', muteOrUnmuteVoice);
$btnMessage.addEventListener('click', sendMessage);

if (typeof navigator.mediaDevices.getDisplayMedia === 'undefined') {
  $txtScreen.innerHTML = 'Not supported';
  $btnScreen.disabled = true;
}

async function loadDevice(routerRtpCapabilities) {
  try {
    device = new mediasoup.Device();
  } catch (error) {
    if (error.name === 'UnsupportedError') {
      console.error('browser not supported');
    }
  }
  await device.load({ routerRtpCapabilities });
}

async function getUserAudioMedia() {
  if (!device.canProduce('audio')) {
    console.error('cannot produce audio');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    return stream;
  } catch (err) {
    console.error('getUserMedia() failed:', err.message);
    throw err;
  }
}

async function getUserMedia(transport, isWebcam) {
  if (!device.canProduce('video')) {
    console.error('cannot produce video');
    return;
  }

  let stream;
  try {
    if (isWebcam) {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio : false,
        video :
        {
          displaySurface : 'monitor',
          logicalSurface : true,
          cursor         : true,
          width          : { max: 1920 },
          height         : { max: 1080 },
          frameRate      : { max: 30 }
        }
      });
    }
  } catch (err) {
    console.error('getUserMedia() failed:', err.message);
    throw err;
  }
  return stream;
}

async function connect() {
  $btnConnect.disabled = true;
  $txtConnection.innerHTML = 'Connecting...';

  const opts = {
    path: '/server',
    transports: ['websocket'],
  };

  const serverUrl = `https://${hostname}:${config.listenPort}`;
  socket = socketClient(serverUrl, opts);
  socket.request = socketPromise(socket);
  let isLoadDevice = false;

  socket.on('connect', async () => {
    $txtConnection.innerHTML = 'Connected';

    const data = await socket.request('getRouterRtpCapabilities');
    await loadDevice(data);
    isLoadDevice = true;
    socket.emit('clientIsReady');
  });

  socket.on('disconnect', () => {
    $txtConnection.innerHTML = 'Disconnected';
    $btnConnect.disabled = false;
  });

  socket.on('log', (data) => {
    $logBox.append(`${data}\n`);
  });

  socket.on('message', (data) => {
    const str = `${data.id}: ${data.message}\n`;
    $messageBox.append(str);
  });

  socket.on('users', (users) => {
    const userStr = users
      .map(user=> 
        `${user.id}_${user.is_presenter ? 'presenter': 'viewer'}_${user.availableProducerIds.length ? 'unmute':'mute'}`
      )
      .join('\n');
    subscribeUsersVoices(users);
    $userBox.innerHTML = userStr;
  });

  socket.on('connect_error', (error) => {
    console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
    $txtConnection.innerHTML = 'Connection failed';
    $btnConnect.disabled = false;
  });

  socket.on('newPresenter', () => {
    if (isLoadDevice) {
      subscribeScreenShare().then().catch(error=>console.error(error))
    }
  });
}

async function findOrCreateVideoAndAudioSendTransport() {
  if (sendTransport) {
    return sendTransport;
  }

  const data = await socket.request('createVideoAndAudioTransport', {
    forceTcp: false,
    rtpCapabilities: device.rtpCapabilities,
  });
  sendTransport = device.createSendTransport(data);
  sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    socket
      .request('connectVideoAndAudioTransport', { 
        transportId: sendTransport.id,
        dtlsParameters,
      })
      .then(callback)
      .catch(errback);
  });

  sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
    try {
      const { id } = await socket.request('produceVideoAndAudio', {
        transportId: sendTransport.id,
        kind,
        rtpParameters,
      });
      callback({ id });
    } catch (err) {
      errback(err);
    }
  });
  
  sendTransport.on('connectionstatechange', async (state) => {
    switch (state) {
      case 'connecting':
        break;

      case 'connected':
        break;

      case 'failed':
        transport.close();
        break;

      default: break;
    }
  });

  return sendTransport;
}

async function findOrCreateVideoAndAudioReceviceTransport() {
  if (receviceTransport) {
    return receviceTransport;
  }

  const data = await socket.request('createVideoAndAudioTransport', {
    forceTcp: false,
    rtpCapabilities: device.rtpCapabilities,
  });
  receviceTransport = device.createRecvTransport(data);
  receviceTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    socket
      .request('connectVideoAndAudioTransport', { 
        transportId: receviceTransport.id,
        dtlsParameters,
      })
      .then(callback)
      .catch(errback);
  });

  receviceTransport.on('connectionstatechange', async (state) => {
    switch (state) {
      case 'connecting':
        break;

      case 'connected':
        break;

      case 'failed':
        transport.close();
        break;

      default: break;
    }
  });

  return receviceTransport;
}

let isMuteVoice = true;
let voiceProducer = null;
async function muteOrUnmuteVoice() {
  if (isMuteVoice) {
    await publishVoice()
  } else {
    if (voiceProducer) {
      await socket.request('deleteProduce', { producerId: voiceProducer.id });
      voiceProducer.close();
      voiceProducer = null;
    }
    $txtVoice.innerHTML = 'mute';
  }

  isMuteVoice = !isMuteVoice;
}

async function publishVoice() {
  const $txtPublish = $txtVoice;

  try {
    let stream = await getUserAudioMedia();
    const sendTransport = await findOrCreateVideoAndAudioSendTransport();
    const track = stream.getAudioTracks()[0];
    const params = { 
      track,
      codecOptions :
          {
						opusStereo : true,
						opusDtx    : true
					}
    };
    
    voiceProducer = await sendTransport.produce(params);
    await socket.request('produceVideoAndAudioFinish', { producerId: voiceProducer._id });
    $txtPublish.innerHTML = 'unmute';
  } catch (err) {
    console.error(err);
    $txtPublish.innerHTML = 'failed';
  }
}

async function sendMessage() {
  const message = inputMessage.value;
  inputMessage.value = '';
  await socket.request('message', { message });
}

async function publishScreenShare(e) {
  const $txtPublish = $txtScreen;
  let stream = await getUserMedia(undefined, false);

  const data = await socket.request('createPresenterProducerTransport', {
    forceTcp: false,
    rtpCapabilities: device.rtpCapabilities,
  });
  if (data.error) {
    console.error(data.error);
    return;
  }

  const transport = device.createSendTransport(data);
  transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    socket.request('connectPresenterProducerTransport', { dtlsParameters })
      .then(callback)
      .catch(errback);
  });

  transport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
    try {
      const { id } = await socket.request('presenterProduce', {
        transportId: transport.id,
        kind,
        rtpParameters,
      });
      callback({ id });
    } catch (err) {
      errback(err);
    }
  });

  transport.on('connectionstatechange', (state) => {
    switch (state) {
      case 'connecting':
        $txtPublish.innerHTML = 'publishing...';
        break;
      case 'connected':
        $txtPublish.innerHTML = 'published';
        break;
      case 'failed':
        transport.close();
        $txtPublish.innerHTML = 'failed';
        break;
      default: 
        break;
    }
  });

  try {
    const track = stream.getVideoTracks()[0];
    const params = { track };
    if ($chkSimulcast.checked) {
      params.encodings = [
        { maxBitrate: 100000 },
        { maxBitrate: 300000 },
        { maxBitrate: 900000 },
      ];
      params.codecOptions = {
        videoGoogleStartBitrate : 1000
      };
    }
    const data = await transport.produce(params);
  } catch (err) {
    console.error(err);
    $txtPublish.innerHTML = 'failed';
  }
}

async function getConsumer(producerId) {
  const recvTransport = await findOrCreateVideoAndAudioReceviceTransport();
  const { rtpCapabilities } = device;
  const data = await socket.request('consumeVideoAndAudio', {
    transportId: recvTransport.id,
    producerId,
    rtpCapabilities 
  });
  const {
    id,
    kind,
    rtpParameters,
  } = data;

  let codecOptions = {};
  const consumer = await recvTransport.consume({
    id,
    producerId,
    kind,
    rtpParameters,
    codecOptions,
  });

  return consumer;
}

const voiceStream = new MediaStream();

async function subscribeUsersVoices(users) {
  const needConnectProducerIds = users
    .filter(user => user.id !== socket.id && user.availableProducerIds.length)
    .map(user => user.availableProducerIds[0]);
  const producerIds = Array.from(voiceConsumers.keys());

  for (const producerId of producerIds) {
    if (needConnectProducerIds.includes(producerId)) {
      continue;
    }
    const consumer = voiceConsumers.get(producerId);
    if (consumer) {
      voiceStream.removeTrack(consumer.track);
      voiceConsumers.delete(producerId);
    }
  }
  for (const producerId of needConnectProducerIds) {
    let consumer = voiceConsumers.get(producerId);
    if (!consumer) {
      consumer = await getConsumer(producerId);
      voiceConsumers.set(producerId, consumer);
    }
    voiceStream.addTrack(consumer.track);
  }
  document.querySelector('#remote_voice').srcObject = voiceStream;
}

async function subscribeScreenShare() {
  const data = await socket.request('createPresenterConsumerTransport', {
    forceTcp: false,
  });
  if (data.error) {
    console.error(data.error);
    return;
  }

  const transport = device.createRecvTransport(data);
  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.request('connectPresenterConsumerTransport', {
      transportId: transport.id,
      dtlsParameters
    })
      .then(callback)
      .catch(errback);
  });

  transport.on('connectionstatechange', async (state) => {
    switch (state) {
      case 'connecting':
        break;

      case 'connected':
        const stream = await streams;
        document.querySelector('#remote_video').srcObject = stream;
        break;

      case 'failed':
        transport.close();
        break;

      default: break;
    }
  });

  const streams = consumePresenter(transport);
}

async function consumePresenter(transport) {
  const { rtpCapabilities } = device;
  const data = await socket.request('consumePresenter', { rtpCapabilities });
  const {
    producerId,
    id,
    kind,
    rtpParameters,
  } = data;

  let codecOptions = {};
  const consumer = await transport.consume({
    id,
    producerId,
    kind,
    rtpParameters,
    codecOptions,
  });

  const stream = new MediaStream();
  stream.addTrack(consumer.track);

  return stream;
}
