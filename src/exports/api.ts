import { EventEmitter } from "events"
import * as vscode from "vscode"

import { ClineProvider } from "../core/webview/ClineProvider"

import { RooCodeAPI, RooCodeEvents, ConfigurationValues, TokenUsage } from "./roo-code"
import { MessageHistory } from "./message-history"
import { IpcClientMessageType, IpcServerMessageType, IpcServer } from "./ipc"

export class API extends EventEmitter<RooCodeEvents> implements RooCodeAPI {
	private readonly outputChannel: vscode.OutputChannel
	private readonly provider: ClineProvider
	private readonly history: MessageHistory
	private readonly tokenUsage: Record<string, TokenUsage>
	private readonly ipc?: IpcServer

	constructor(outputChannel: vscode.OutputChannel, provider: ClineProvider, socketPath?: string) {
		super()

		this.outputChannel = outputChannel
		this.provider = provider
		this.history = new MessageHistory()
		this.tokenUsage = {}

		this.provider.on("clineAdded", (cline) => {
			cline.on("message", (message) => this.emit("message", { taskId: cline.taskId, ...message }))
			cline.on("taskStarted", () => this.emit("taskStarted", cline.taskId))
			cline.on("taskPaused", () => this.emit("taskPaused", cline.taskId))
			cline.on("taskUnpaused", () => this.emit("taskUnpaused", cline.taskId))
			cline.on("taskAskResponded", () => this.emit("taskAskResponded", cline.taskId))
			cline.on("taskAborted", () => this.emit("taskAborted", cline.taskId))
			cline.on("taskSpawned", (childTaskId) => this.emit("taskSpawned", cline.taskId, childTaskId))
			cline.on("taskCompleted", (_, usage) => this.emit("taskCompleted", cline.taskId, usage))
			cline.on("taskTokenUsageUpdated", (_, usage) => this.emit("taskTokenUsageUpdated", cline.taskId, usage))
		})

		this.on("message", ({ taskId, action, message }) => {
			if (action === "created") {
				this.history.add(taskId, message)
			} else if (action === "updated") {
				this.history.update(taskId, message)
			}
		})

		this.on("taskTokenUsageUpdated", (taskId, usage) => (this.tokenUsage[taskId] = usage))

		if (socketPath) {
			this.ipc = new IpcServer(socketPath)
			this.ipc.listen()

			this.ipc.on("message", (message) => {
				switch (message.type) {
					case IpcClientMessageType.StartNewTask:
						this.startNewTask(message.data.text, message.data.images)
						break
				}
			})
		}
	}

	public override emit<K extends keyof RooCodeEvents>(
		eventName: K,
		...args: K extends keyof RooCodeEvents ? RooCodeEvents[K] : never
	) {
		if (this.ipc) {
			this.ipc.broadcast({ type: IpcServerMessageType.TaskEvent, data: { eventName, data: { ...args } } })
		}

		return super.emit(eventName, ...args)
	}

	public async startNewTask(text?: string, images?: string[]) {
		await this.provider.removeClineFromStack()
		await this.provider.postStateToWebview()
		await this.provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		await this.provider.postMessageToWebview({ type: "invoke", invoke: "newChat", text, images })

		const cline = await this.provider.initClineWithTask(text, images)
		return cline.taskId
	}

	public getCurrentTaskStack() {
		return this.provider.getCurrentTaskStack()
	}

	public async clearCurrentTask(lastMessage?: string) {
		await this.provider.finishSubTask(lastMessage)
	}

	public async cancelCurrentTask() {
		await this.provider.cancelTask()
	}

	public async sendMessage(text?: string, images?: string[]) {
		await this.provider.postMessageToWebview({ type: "invoke", invoke: "sendMessage", text, images })
	}

	public async pressPrimaryButton() {
		await this.provider.postMessageToWebview({ type: "invoke", invoke: "primaryButtonClick" })
	}

	public async pressSecondaryButton() {
		await this.provider.postMessageToWebview({ type: "invoke", invoke: "secondaryButtonClick" })
	}

	// TODO: Change this to `setApiConfiguration`.
	public async setConfiguration(values: Partial<ConfigurationValues>) {
		await this.provider.setValues(values)
	}

	public isReady() {
		return this.provider.viewLaunched
	}

	public getMessages(taskId: string) {
		return this.history.getMessages(taskId)
	}

	public getTokenUsage(taskId: string) {
		return this.tokenUsage[taskId]
	}

	public log(message: string) {
		this.outputChannel.appendLine(message)
	}
}
