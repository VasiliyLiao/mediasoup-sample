# Depends

it's base on https://github.com/mkhahani/mediasoup-sample-app

# Mediasoup Sample App

A minimal Client/Server app based on Mediasoup and Socket.io
(many-to-many voices)
(one-ton-many screenshare)

## Dependencies

* [Mediasoup v3 requirements](https://mediasoup.org/documentation/v3/mediasoup/installation/#requirements)
* Node.js >= v8.6
* [Browserify](http://browserify.org/)


## Run

The server app runs on any supported platform by Mediasoup. The client app runs on a single browser tab.
```
# create and modify the configuration
# make sure you set the proper IP for mediasoup.webRtcTransport.listenIps
cp config.example.js config.js
nano config.js

# install dependencies and build mediasoup
npm install

# create the client bundle and start the server app
npm start
```
