/**
 * @module _APICore
 */
const nodeFetch = require('node-fetch');

class APIError extends Error {

}

class NotJSONAPIError extends APIError {
    constructor(status) {
        super(`the api response is not JSON type. http status: ${status}`);
    }
}

class NotSuccessError extends APIError {

}

class NotFoundError extends APIError {

}

function errorHandle(statusCode, message) {
    if (Number(statusCode) == 404) {
        throw new NotFoundError(`NotFound. ${message}`);
    }

    throw new NotSuccessError(`the status code is ${statusCode}. API message: ${message}`);
}

/**
 *
 * @param {string} url
 * @param {object} params
 */
const callJSONAPI = async (url, params) => {
    const resp = await nodeFetch(url, params);
    let payload = null;

    try {
        payload = await resp.json();
    }
    catch (error) {
        throw new NotJSONAPIError(resp.status);
    }

    const { error } = payload;

    if (!resp.ok || error) {
        const { code, message } = error;
        errorHandle(code || resp.status, message);
    }

    return payload;
};

module.exports = {
    Errors: {
        APIError,
        NotJSONAPIError,
        NotFoundError,
        NotSuccessError,
    },
    callJSONAPI
};