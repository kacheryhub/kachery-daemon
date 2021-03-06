import { LocalFeedManagerInterface } from '../core/ExternalInterface';
import { verifySignature } from '../../commonInterface/crypto/signatures';
import { FeedId, JSONObject, messageCount, PublicKey, Signature, SignedSubfeedMessage, SubfeedHash } from '../../commonInterface/kacheryTypes';

class LocalSubfeedSignedMessagesManager {
    #signedMessages: SignedSubfeedMessage[] | null = null // in-memory cache
    constructor(private localFeedManager: LocalFeedManagerInterface, private feedId: FeedId, private subfeedHash: SubfeedHash, private publicKey: PublicKey) {

    }
    async initializeFromLocal() {
        const messages = await this.localFeedManager.getSignedSubfeedMessages(this.feedId, this.subfeedHash)

        // Verify the integrity of the messages
        // The first message has a previousSignature of null
        let previousSignature: Signature | null = null
        let previousMessageNumber: number = -1
        for (let msg of messages) {
            if (!await verifySignature(msg.body as any as JSONObject, this.publicKey, msg.signature)) {
                /* istanbul ignore next */
                throw Error(`Unable to verify signature of message in feed: ${msg.signature}`)
            }
            if (previousSignature !== (msg.body.previousSignature || null)) {
                /* istanbul ignore next */
                throw Error(`Inconsistent previousSignature of message in feed when reading messages from file: ${previousSignature} ${msg.body.previousSignature}`)
            }
            if (previousMessageNumber + 1 !== msg.body.messageNumber) {
                /* istanbul ignore next */
                throw Error(`Incorrect message number for message in feed when reading messages from file: ${previousMessageNumber + 1} ${msg.body.messageNumber}`)
            }
            previousSignature = msg.signature
            previousMessageNumber = msg.body.messageNumber
        }

        // store in memory
        this.#signedMessages = messages
    }
    initializeEmptyMessageList() {
        this.#signedMessages = []
    }
    isInitialized = () => {
        return this.#signedMessages !== null
    }
    getNumMessages() {
        if (this.#signedMessages === null) {
            /* istanbul ignore next */
            throw Error('#signedMessages is null. Perhaps getNumMessages was called before subfeed was initialized.');
        }
        return messageCount(this.#signedMessages.length)
    }
    getMessages() {
        if (this.#signedMessages === null) {
            /* istanbul ignore next */
            throw Error('#signedMessages is null. Perhaps getMessages was called before subfeed was initialized.');
        }
        return this.#signedMessages.map(m => m.body.message)
    }
    getSignedMessage(i: number) {
        if (this.#signedMessages === null) {
            /* istanbul ignore next */
            throw Error('#signedMessages is null. Perhaps getSignedMessage was called before subfeed was initialized.');
        }
        return this.#signedMessages[i]
    }
    async addSignedMessages(signedMessagesToAdd: SignedSubfeedMessage[]) {
        if (this.#signedMessages === null) {
            /* istanbul ignore next */
            throw Error('#signedMessages is null. Perhaps appendSignedMessages was called before subfeed was initialized.');
        }
        const firstAppendMessageNumber = signedMessagesToAdd.length === 0 ? null : signedMessagesToAdd[0].body.messageNumber
        const lastExistingMessageNumber = this.#signedMessages.length === 0 ? null : this.#signedMessages[this.#signedMessages.length - 1].body.messageNumber
        if (firstAppendMessageNumber !== null) {
            if (lastExistingMessageNumber === null) {       
                if (firstAppendMessageNumber !== 0) throw Error('Unexpected in appendSignedMessages: first message number to append does not equal zero')
            }
            else {
                if (firstAppendMessageNumber > lastExistingMessageNumber + 1) throw Error(`Unexpected in appendSignedMessages: unexpcted first message number for appending ${firstAppendMessageNumber} > ${lastExistingMessageNumber + 1}`)
            }
        }
        // CHAIN:append_messages:step(6)
        await this.localFeedManager.addSignedMessagesToSubfeed(this.feedId, this.subfeedHash, signedMessagesToAdd)
        for (let sm of signedMessagesToAdd) {
            if (sm.body.messageNumber === this.#signedMessages.length) {
                this.#signedMessages.push(sm)
            }
        }
    }
}

export default LocalSubfeedSignedMessagesManager
