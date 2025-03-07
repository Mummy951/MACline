import { EventEmitter } from "events"
import stripAnsi from "strip-ansi"
import * as vscode from "vscode"
import { inspect } from "util"

export interface ExitCodeDetails {
	exitCode: number | undefined
	signal?: number | undefined
	signalName?: string
	coreDumpPossible?: boolean
}
import { Terminal } from "./Terminal"
import { TerminalRegistry } from "./TerminalRegistry"

export interface TerminalProcessEvents {
	line: [line: string]
	continue: []
	completed: [output?: string]
	error: [error: Error]
	no_shell_integration: []
	/**
	 * Emitted when a shell execution completes
	 * @param id The terminal ID
	 * @param exitDetails Contains exit code and signal information if process was terminated by signal
	 */
	shell_execution_complete: [id: number, exitDetails: ExitCodeDetails]
	stream_available: [id: number, stream: AsyncIterable<string>]
}

// how long to wait after a process outputs anything before we consider it "cool" again
const PROCESS_HOT_TIMEOUT_NORMAL = 2_000
const PROCESS_HOT_TIMEOUT_COMPILING = 15_000

export class TerminalProcess extends EventEmitter<TerminalProcessEvents> {
	private isListening: boolean = true
	private terminalInfo: Terminal
	private lastEmitTime_ms: number = 0
	private fullOutput: string = ""
	private lastRetrievedIndex: number = 0
	isHot: boolean = false
	constructor(terminal: Terminal) {
		super()

		// Store terminal info for later use
		this.terminalInfo = terminal

		// Set up event handlers
		this.once("completed", () => {
			if (this.terminalInfo) {
				this.terminalInfo.busy = false
			}
		})

		this.once("no_shell_integration", () => {
			if (this.terminalInfo) {
				console.log(`no_shell_integration received for terminal ${this.terminalInfo.id}`)
				TerminalRegistry.removeTerminal(this.terminalInfo.id)
			}
		})
	}

	static interpretExitCode(exitCode: number | undefined): ExitCodeDetails {
		if (exitCode === undefined) {
			return { exitCode }
		}

		if (exitCode <= 128) {
			return { exitCode }
		}

		const signal = exitCode - 128
		const signals: Record<number, string> = {
			// Standard signals
			1: "SIGHUP",
			2: "SIGINT",
			3: "SIGQUIT",
			4: "SIGILL",
			5: "SIGTRAP",
			6: "SIGABRT",
			7: "SIGBUS",
			8: "SIGFPE",
			9: "SIGKILL",
			10: "SIGUSR1",
			11: "SIGSEGV",
			12: "SIGUSR2",
			13: "SIGPIPE",
			14: "SIGALRM",
			15: "SIGTERM",
			16: "SIGSTKFLT",
			17: "SIGCHLD",
			18: "SIGCONT",
			19: "SIGSTOP",
			20: "SIGTSTP",
			21: "SIGTTIN",
			22: "SIGTTOU",
			23: "SIGURG",
			24: "SIGXCPU",
			25: "SIGXFSZ",
			26: "SIGVTALRM",
			27: "SIGPROF",
			28: "SIGWINCH",
			29: "SIGIO",
			30: "SIGPWR",
			31: "SIGSYS",

			// Real-time signals base
			34: "SIGRTMIN",

			// SIGRTMIN+n signals
			35: "SIGRTMIN+1",
			36: "SIGRTMIN+2",
			37: "SIGRTMIN+3",
			38: "SIGRTMIN+4",
			39: "SIGRTMIN+5",
			40: "SIGRTMIN+6",
			41: "SIGRTMIN+7",
			42: "SIGRTMIN+8",
			43: "SIGRTMIN+9",
			44: "SIGRTMIN+10",
			45: "SIGRTMIN+11",
			46: "SIGRTMIN+12",
			47: "SIGRTMIN+13",
			48: "SIGRTMIN+14",
			49: "SIGRTMIN+15",

			// SIGRTMAX-n signals
			50: "SIGRTMAX-14",
			51: "SIGRTMAX-13",
			52: "SIGRTMAX-12",
			53: "SIGRTMAX-11",
			54: "SIGRTMAX-10",
			55: "SIGRTMAX-9",
			56: "SIGRTMAX-8",
			57: "SIGRTMAX-7",
			58: "SIGRTMAX-6",
			59: "SIGRTMAX-5",
			60: "SIGRTMAX-4",
			61: "SIGRTMAX-3",
			62: "SIGRTMAX-2",
			63: "SIGRTMAX-1",
			64: "SIGRTMAX",
		}

		// These signals may produce core dumps:
		//   SIGQUIT, SIGILL, SIGABRT, SIGBUS, SIGFPE, SIGSEGV
		const coreDumpPossible = new Set([3, 4, 6, 7, 8, 11])

		return {
			exitCode,
			signal,
			signalName: signals[signal] || `Unknown Signal (${signal})`,
			coreDumpPossible: coreDumpPossible.has(signal),
		}
	}
	private hotTimer: NodeJS.Timeout | null = null

	async run(command: string) {
		const terminal = this.terminalInfo.terminal

		if (terminal.shellIntegration && terminal.shellIntegration.executeCommand) {
			// Create a promise that resolves when the stream becomes available
			const streamAvailable = new Promise<AsyncIterable<string>>((resolve) => {
				this.once("stream_available", (id: number, stream: AsyncIterable<string>) => {
					if (id === this.terminalInfo.id) {
						resolve(stream)
					}
				})
			})

			// Create promise that resolves when shell execution completes for this terminal
			const shellExecutionComplete = new Promise<ExitCodeDetails>((resolve) => {
				this.once("shell_execution_complete", (id: number, exitDetails: ExitCodeDetails) => {
					if (id === this.terminalInfo.id) {
						resolve(exitDetails)
					}
				})
			})

			// Execute command
			terminal.shellIntegration.executeCommand(command)
			this.isHot = true

			// Wait for stream to be available
			const stream = await streamAvailable

			let preOutput = ""
			let commandOutputStarted = false

			/*
			 * Extract clean output from raw accumulated output. FYI:
			 * ]633 is a custom sequence number used by VSCode shell integration:
			 * - OSC 633 ; A ST - Mark prompt start
			 * - OSC 633 ; B ST - Mark prompt end
			 * - OSC 633 ; C ST - Mark pre-execution (start of command output)
			 * - OSC 633 ; D [; <exitcode>] ST - Mark execution finished with optional exit code
			 * - OSC 633 ; E ; <commandline> [; <nonce>] ST - Explicitly set command line with optional nonce
			 */

			// Process stream data
			for await (let data of stream) {
				// Check for command output start marker
				if (!commandOutputStarted) {
					preOutput += data
					const match = this.matchAfterVsceStartMarkers(data)
					if (match !== undefined) {
						commandOutputStarted = true
						data = match
						this.fullOutput = "" // Reset fullOutput when command actually starts
						this.emit("line", "") // Trigger UI to proceed
					} else {
						continue
					}
				}

				// Command output started, accumulate data without filtering.
				// notice to future programmers: do not add escape sequence
				// filtering here: fullOutput cannot change in length (see getUnretrievedOutput),
				// and chunks may not be complete so you cannot rely on detecting or removing escape sequences mid-stream.
				this.fullOutput += data

				// For non-immediately returning commands we want to show loading spinner
				// right away but this wouldnt happen until it emits a line break, so
				// as soon as we get any output we emit to let webview know to show spinner
				const now = Date.now()
				if (this.isListening && (now - this.lastEmitTime_ms > 100 || this.lastEmitTime_ms === 0)) {
					this.emitRemainingBufferIfListening()
					this.lastEmitTime_ms = now
				}

				// 2. Set isHot depending on the command.
				// This stalls API requests until terminal is cool again.
				this.isHot = true
				if (this.hotTimer) {
					clearTimeout(this.hotTimer)
				}
				// these markers indicate the command is some kind of local dev server recompiling the app, which we want to wait for output of before sending request to cline
				const compilingMarkers = ["compiling", "building", "bundling", "transpiling", "generating", "starting"]
				const markerNullifiers = [
					"compiled",
					"success",
					"finish",
					"complete",
					"succeed",
					"done",
					"end",
					"stop",
					"exit",
					"terminate",
					"error",
					"fail",
				]
				const isCompiling =
					compilingMarkers.some((marker) => data.toLowerCase().includes(marker.toLowerCase())) &&
					!markerNullifiers.some((nullifier) => data.toLowerCase().includes(nullifier.toLowerCase()))
				this.hotTimer = setTimeout(
					() => {
						this.isHot = false
					},
					isCompiling ? PROCESS_HOT_TIMEOUT_COMPILING : PROCESS_HOT_TIMEOUT_NORMAL,
				)
			}

			// Set streamClosed immediately after stream ends
			if (this.terminalInfo) {
				this.terminalInfo.setActiveStream(undefined)
			}

			// Wait for shell execution to complete and handle exit details
			const exitDetails = await shellExecutionComplete
			this.isHot = false

			if (commandOutputStarted) {
				// Emit any remaining output before completing
				this.emitRemainingBufferIfListening()
			} else {
				console.error(
					"[Terminal Process] VSCE output start escape sequence (]633;C or ]133;C) not received! VSCE Bug? preOutput: " +
						inspect(preOutput, { colors: false, breakLength: Infinity }),
				)
			}

			// console.debug("[Terminal Process] raw output: " + inspect(output, { colors: false, breakLength: Infinity }))

			// fullOutput begins after C marker so we only need to trim off D marker
			// (if D exists, see VSCode bug# 237208):
			const match = this.matchBeforeVsceEndMarkers(this.fullOutput)
			if (match !== undefined) {
				this.fullOutput = match
			}

			// console.debug(`[Terminal Process] processed output via ${matchSource}: ` + inspect(output, { colors: false, breakLength: Infinity }))

			// for now we don't want this delaying requests since we don't send diagnostics automatically anymore (previous: "even though the command is finished, we still want to consider it 'hot' in case so that api request stalls to let diagnostics catch up")
			if (this.hotTimer) {
				clearTimeout(this.hotTimer)
			}
			this.isHot = false

			this.emit("completed", this.removeEscapeSequences(this.fullOutput))
		} else {
			terminal.sendText(command, true)

			// Do not execute commands when shell integration is not available
			console.warn(
				"[TerminalProcess] Shell integration not available. Command sent without knowledge of response.",
			)
			this.emit("no_shell_integration")

			// unknown, but trigger the event
			this.emit(
				"completed",
				"<shell integration is not available, so terminal output and command execution status is unknown>",
			)
		}

		this.emit("continue")
	}

	private emitRemainingBufferIfListening() {
		if (this.isListening) {
			const remainingBuffer = this.getUnretrievedOutput()
			if (remainingBuffer !== "") {
				this.emit("line", remainingBuffer)
			}
		}
	}

	continue() {
		this.emitRemainingBufferIfListening()
		this.isListening = false
		this.removeAllListeners("line")
		this.emit("continue")
	}

	// Returns complete lines with their carriage returns.
	// The final line may lack a carriage return if the program didn't send one.
	getUnretrievedOutput(): string {
		// Get raw unretrieved output
		let outputToProcess = this.fullOutput.slice(this.lastRetrievedIndex)

		// Check for VSCE command end markers
		const index633 = outputToProcess.indexOf("\x1b]633;D")
		const index133 = outputToProcess.indexOf("\x1b]133;D")
		let endIndex = -1

		if (index633 !== -1 && index133 !== -1) {
			endIndex = Math.min(index633, index133)
		} else if (index633 !== -1) {
			endIndex = index633
		} else if (index133 !== -1) {
			endIndex = index133
		}

		// If no end markers were found yet (possibly due to VSCode bug#237208):
		//   For active streams: return only complete lines (up to last \n).
		//   For closed streams: return all remaining content.
		if (endIndex === -1) {
			if (this.terminalInfo && !this.terminalInfo.isStreamClosed()) {
				// Stream still running - only process complete lines
				endIndex = outputToProcess.lastIndexOf("\n")
				if (endIndex === -1) {
					// No complete lines
					return ""
				}

				// Include carriage return
				endIndex++
			} else {
				// Stream closed - process all remaining output
				endIndex = outputToProcess.length
			}
		}

		// Update index and slice output
		this.lastRetrievedIndex += endIndex
		outputToProcess = outputToProcess.slice(0, endIndex)

		// Clean and return output
		return this.removeEscapeSequences(outputToProcess)
	}

	private stringIndexMatch(
		data: string,
		prefix?: string,
		suffix?: string,
		bell: string = "\x07",
	): string | undefined {
		let startIndex: number
		let endIndex: number
		let prefixLength: number

		if (prefix === undefined) {
			startIndex = 0
			prefixLength = 0
		} else {
			startIndex = data.indexOf(prefix)
			if (startIndex === -1) {
				return undefined
			}
			if (bell.length > 0) {
				// Find the bell character after the prefix
				const bellIndex = data.indexOf(bell, startIndex + prefix.length)
				if (bellIndex === -1) {
					return undefined
				}

				const distanceToBell = bellIndex - startIndex

				prefixLength = distanceToBell + bell.length
			} else {
				prefixLength = prefix.length
			}
		}

		const contentStart = startIndex + prefixLength

		if (suffix === undefined) {
			// When suffix is undefined, match to end
			endIndex = data.length
		} else {
			endIndex = data.indexOf(suffix, contentStart)
			if (endIndex === -1) {
				return undefined
			}
		}

		return data.slice(contentStart, endIndex)
	}

	// Removes ANSI escape sequences and VSCode-specific terminal control codes from output.
	// While stripAnsi handles most ANSI codes, VSCode's shell integration adds custom
	// escape sequences (OSC 633) that need special handling. These sequences control
	// terminal features like marking command start/end and setting prompts.
	//
	// This method could be extended to handle other escape sequences, but any additions
	// should be carefully considered to ensure they only remove control codes and don't
	// alter the actual content or behavior of the output stream.
	private removeEscapeSequences(str: string): string {
		return stripAnsi(str.replace(/\x1b\]633;[^\x07]+\x07/gs, "").replace(/\x1b\]133;[^\x07]+\x07/gs, ""))
	}

	/**
	 * Helper function to match VSCode shell integration start markers (C).
	 * Looks for content after ]633;C or ]133;C markers.
	 * If both exist, takes the content after the last marker found.
	 */
	private matchAfterVsceStartMarkers(data: string): string | undefined {
		return this.matchVsceMarkers(data, "\x1b]633;C", "\x1b]133;C", undefined, undefined)
	}

	/**
	 * Helper function to match VSCode shell integration end markers (D).
	 * Looks for content before ]633;D or ]133;D markers.
	 * If both exist, takes the content before the first marker found.
	 */
	private matchBeforeVsceEndMarkers(data: string): string | undefined {
		return this.matchVsceMarkers(data, undefined, undefined, "\x1b]633;D", "\x1b]133;D")
	}

	/**
	 * Handles VSCode shell integration markers for command output:
	 *
	 * For C (Command Start):
	 * - Looks for content after ]633;C or ]133;C markers
	 * - These markers indicate the start of command output
	 * - If both exist, takes the content after the last marker found
	 * - This ensures we get the actual command output after any shell integration prefixes
	 *
	 * For D (Command End):
	 * - Looks for content before ]633;D or ]133;D markers
	 * - These markers indicate command completion
	 * - If both exist, takes the content before the first marker found
	 * - This ensures we don't include shell integration suffixes in the output
	 *
	 * In both cases, checks 633 first since it's more commonly used in VSCode shell integration
	 *
	 * @param data The string to search for markers in
	 * @param prefix633 The 633 marker to match after (for C markers)
	 * @param prefix133 The 133 marker to match after (for C markers)
	 * @param suffix633 The 633 marker to match before (for D markers)
	 * @param suffix133 The 133 marker to match before (for D markers)
	 * @returns The content between/after markers, or undefined if no markers found
	 *
	 * Note: Always makes exactly 2 calls to stringIndexMatch regardless of match results.
	 * Using string indexOf matching is ~500x faster than regular expressions, so even
	 * matching twice is still very efficient comparatively.
	 */
	private matchVsceMarkers(
		data: string,
		prefix633: string | undefined,
		prefix133: string | undefined,
		suffix633: string | undefined,
		suffix133: string | undefined,
	): string | undefined {
		// Support both VSCode shell integration markers (633 and 133)
		// Check 633 first since it's more commonly used in VSCode shell integration
		let match133: string | undefined
		const match633 = this.stringIndexMatch(data, prefix633, suffix633)

		// Must check explicitly for undefined because stringIndexMatch can return empty strings
		// that are valid matches (e.g., when a marker exists but has no content between markers)
		if (match633 !== undefined) {
			match133 = this.stringIndexMatch(match633, prefix133, suffix133)
		} else {
			match133 = this.stringIndexMatch(data, prefix133, suffix133)
		}

		return match133 !== undefined ? match133 : match633
	}
}

export type TerminalProcessResultPromise = TerminalProcess & Promise<void>

// Similar to execa's ResultPromise, this lets us create a mixin of both a TerminalProcess and a Promise: https://github.com/sindresorhus/execa/blob/main/lib/methods/promise.js
export function mergePromise(process: TerminalProcess, promise: Promise<void>): TerminalProcessResultPromise {
	const nativePromisePrototype = (async () => {})().constructor.prototype
	const descriptors = ["then", "catch", "finally"].map(
		(property) => [property, Reflect.getOwnPropertyDescriptor(nativePromisePrototype, property)] as const,
	)
	for (const [property, descriptor] of descriptors) {
		if (descriptor) {
			const value = descriptor.value.bind(promise)
			Reflect.defineProperty(process, property, { ...descriptor, value })
		}
	}
	return process as TerminalProcessResultPromise
}
