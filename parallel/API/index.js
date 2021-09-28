const {
    callJSONAPI,
} = require('./fetch');

const getURLSearchParams = params => {
    const newParams = {};
    Object.entries(params).forEach(([key, value]) => {
        const isSkipValue = value === undefined || value === '';
        if (!isSkipValue) {
            newParams[key] = value;
        }
    });

    return new URLSearchParams(newParams);
};

class APICaller {
    constructor(serviceHost) {
        this.serviceHost = serviceHost;
        this.commonHeaders = {
            'Content-Type': 'application/json',
        };
    }

    getFullUrl(url) {
        return this.serviceHost + '/' + url;
    }

    /**
     *
     * @param {string} url
     * @param {object} queryParams
     * @param {object} headers
     * @returns
     */
    get(url, queryParams = {}, headers = {}) {
        const fullUrl = this.getFullUrl(url);
        const query = getURLSearchParams(queryParams);

        return callJSONAPI(`${fullUrl}?${query}`, {
            method: 'GET',
            headers: {
                ...this.commonHeaders,
                ...headers,
            },
        });
    }

    /**
     *
     * @param {string} url
     * @param {object} body
     * @param {object} headers
     * @returns
     */
    post(url, body, headers = {}) {
        return callJSONAPI(`${this.getFullUrl(url)}`, {
            method: 'POST',
            headers: {
                ...this.commonHeaders,
                ...headers,
            },
            body: JSON.stringify(body),
        });

    }

    /**
     *
     * @param {string} url
     * @param {object} body
     * @param {object} headers
     * @returns
     */
    patch(url, body, headers = {}) {
        return callJSONAPI(`${this.getFullUrl(url)}`, {
            method: 'PATCH',
            headers: {
                ...this.commonHeaders,
                ...headers,
            },
            body: JSON.stringify(body),
        });
    }

    /**
     *
     * @param {string} url
     * @param {object} body
     * @param {object} headers
     * @returns
     */
    delete(url, body = {}, headers = {}) {
        return callJSONAPI(this.getFullUrl(url), {
            method: 'DELETE',
            headers: {
                ...this.commonHeaders,
                ...headers,
            },
            body: JSON.stringify(body),
        });
    }
}

module.exports = APICaller;
