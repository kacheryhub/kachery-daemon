import { action } from "./action"
import { scaledDurationMsec } from "kachery-js/types/kacheryTypes"
import { sleepMsec } from "kachery-js/util/util"
import KacheryDaemonNode from "kachery-js/KacheryDaemonNode"
import KacheryHubClient from "kachery-js/kacheryHubClient/KacheryHubClient"

export default class KacheryHubService {
    #node: KacheryDaemonNode
    #halted = false
    #kacheryHubClient: KacheryHubClient
    constructor(node: KacheryDaemonNode, private opts: {}) {
        this.#node = node
        this.#kacheryHubClient = node.kacheryHubInterface().client()

        this._start()
    }
    stop() {
        this.#halted = true
    }
    async _sendReportToKacheryHub() {
        if (!this.#node.ownerId()) return
        this.#kacheryHubClient.report()
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