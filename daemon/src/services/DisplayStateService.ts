import { NodeChannelMembership } from "../kacheryInterface/kacheryHubTypes";
import { byteCount, durationGreaterThan, elapsedSince, nowTimestamp, Port, unscaledDurationMsec } from "../commonInterface/kacheryTypes";
import { formatByteCount, sleepMsec } from "../commonInterface/util/util";
import KacheryNode from "../kacheryInterface/core/KacheryNode";
import VERSION from "../daemonVersion"
import logger from "winston";

export default class DisplayStateService {
    #node: KacheryNode
    #halted = false
    #lastText = ''
    #lastDisplayTimestamp = nowTimestamp()
    #intervalMsec = unscaledDurationMsec(10000)
    constructor(node: KacheryNode, private opts: {daemonApiPort: Port | null}) {
        this.#node = node

        this._start()
    }
    stop() {
        this.#halted = true
    }
    async _updateDisplay() {
        const lines: string[] = []
        lines.push(`${VERSION}`)
        lines.push(`NODE: ${this.#node.nodeId()} (${this.#node.nodeLabel()})`)
        lines.push(`OWNER: ${this.#node.ownerId() || ''}`)
        const channelMemberships = await this.#node.kacheryHubInterface().getChannelMemberships()
        if (channelMemberships) {
            ;(channelMemberships || []).map(cm => {
                lines.push(`CHANNEL ${cm.channelName} ${makeAuthString(cm)}`)
            })
        }
        // if (this.opts.daemonApiPort)
        //     lines.push(`http://localhost:${this.opts.daemonApiPort}/stats?format=html`)
        if (this.#node.ownerId())
            lines.push(`Configure this node at https://kacheryhub.org - log in as ${this.#node.ownerId()}`)
        else
            lines.push(`No owner ID - node cannot be configured on kacheryhub`)
        const txt = lines.join('\n')
        const elapsed = unscaledDurationMsec(elapsedSince(this.#lastDisplayTimestamp))
        if ((txt !== this.#lastText) || (durationGreaterThan(elapsed, unscaledDurationMsec(30000)))) {
            this.#lastText = txt
            this.#lastDisplayTimestamp = nowTimestamp()
            console.info('')
            console.info('===========================================================')
            console.info(txt)
            const stats = this.#node.getStats({format: 'json'})
            console.info(`Downloaded: ${formatByteCount(stats.totalBytesReceived)}; Uploaded: ${formatByteCount(stats.totalBytesSent)}; Messages sent: ${stats.totalMessagesSent}`)
            console.info(`Memory used: ${formatByteCount(byteCount(process.memoryUsage().heapUsed))} (heap); ${formatByteCount(byteCount(process.memoryUsage().external))} (external); ${formatByteCount(byteCount(process.memoryUsage().arrayBuffers))} (arrayBuffers);`)
            console.info('===========================================================')
        }
    }
    async _start() {
        while (true) {
            if (this.#halted) return
            this._updateDisplay()
            await sleepMsec(this.#intervalMsec, () => {return !this.#halted})
        }
    }
}

const makeAuthString = (cm: NodeChannelMembership) => {
    const ret: string[] = []
    // roles are deprecated
    // if (cm.roles.downloadFiles) ret.push('dfi')
    // if (cm.roles.downloadFeeds) ret.push('dfe')
    // if (cm.roles.downloadTaskResults) ret.push('dtr')
    if (cm.authorization) {
        // if ((cm.roles.requestFiles) && (cm.authorization.permissions.requestFiles))  ret.push('rfi')
        // if ((cm.roles.requestFeeds) && (cm.authorization.permissions.requestFeeds)) ret.push('rfe')
        // if ((cm.roles.requestTasks) && (cm.authorization.permissions.requestTasks)) ret.push('rtr')
        // if ((cm.roles.provideFiles) && (cm.authorization.permissions.provideFiles)) ret.push('pfi')
        // if ((cm.roles.provideFeeds) && (cm.authorization.permissions.provideFeeds)) ret.push('pfe')
        // if ((cm.roles.provideTasks) && (cm.authorization.permissions.provideTasks)) ret.push('ptr')
        if (cm.authorization.permissions.requestFiles)  ret.push('rfi')
        if (cm.authorization.permissions.requestFeeds) ret.push('rfe')
        if (cm.authorization.permissions.requestTasks) ret.push('rtr')
        if (cm.authorization.permissions.provideFiles) ret.push('pfi')
        if (cm.authorization.permissions.provideFeeds) ret.push('pfe')
        if (cm.authorization.permissions.provideTasks) ret.push('ptr')
    }
    return ret.join(' ')
}