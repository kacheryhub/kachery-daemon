import axios from "axios"
import { action } from "../common/action"
import { getSignature } from "../common/types/crypto_util"
import { scaledDurationMsec } from "../common/types/kacheryTypes"
import { sleepMsec } from "../common/util"
import KacheryDaemonNode from "../KacheryDaemonNode"
import KacheryHubClient from "../kacheryHub/KacheryHubClient"

export default class KacheryHubService {
    #node: KacheryDaemonNode
    #halted = false
    #kacheryHubClient: KacheryHubClient
    constructor(node: KacheryDaemonNode, private opts: {}) {
        this.#node = node
        this.#kacheryHubClient = new KacheryHubClient({keyPair: node.keyPair(), nodeLabel: node.nodeLabel(), ownerId: node.ownerId()})

        this._start()
    }
    stop() {
        this.#halted = true
    }
    async _sendReportToKacheryHub() {
        if (!this.#node.ownerId()) return
        this.#kacheryHubClient.report()
        const config = await this.#kacheryHubClient.fetchNodeConfig()
    }
    async _start() {
        const intervalMsec = scaledDurationMsec(1000 * 60 * 5)
        // wait a bit before starting
        await sleepMsec(scaledDurationMsec(1000 * 1), () => {return !this.#halted})
        while (true) {
            if (this.#halted) return
            /////////////////////////////////////////////////////////////////////////
            action('sendReportToKacheryHub', {}, async () => {
                await this._sendReportToKacheryHub()
            }, async (err: Error) => {
                console.warn(`****************************************** Problem reporting to kachery hub (${err.message})`)
            });
            /////////////////////////////////////////////////////////////////////////

            await sleepMsec(intervalMsec, () => {return !this.#halted})
        }
    }
}