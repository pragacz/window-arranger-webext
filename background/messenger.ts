import { ObserveInfo, ObservedIdMapper } from "./observeInfo.js"
import { CommonIdType, CustomIdArrangement, Arrangement } from "./arrangement.js"

type HandleType = string;
const CustomIdName = "handle";
type CustomIdName = typeof CustomIdName;

let appName = "window_arranger";
let port: browser.runtime.Port;
let runningConnection = false;
let messageIdCounter: number;
let observedIdMapper: ObservedIdMapper<CommonIdType, HandleType>;
let rejectAwaitingMessages: Map<number, (reason?: any) => void> = new Map();

class Message {
	source: string;
	id: number;
	type: string;
	value: any;
	constructor(source, id, type, value) {
		this.source = source;
		this.id = id;
		this.type = type;
		this.value = value;
		console.debug(this);
	}
}

interface ResponseMessage extends Message {
	status: string;
}

async function sendMessage(type: "changeObserved", value: ObserveInfo<HandleType>): Promise<CustomIdArrangement<CustomIdName, HandleType>>;
async function sendMessage(type: "getArrangement", value: { handles: string | HandleType[], inObserved: boolean }): Promise<CustomIdArrangement<CustomIdName, HandleType>>;
async function sendMessage(type: "setArrangement", value: CustomIdArrangement<CustomIdName, HandleType>): Promise<CustomIdArrangement<CustomIdName, HandleType>>;
async function sendMessage(type: string, value: any): Promise<any> {
	let messageId = messageIdCounter++;
	let callback: (arg) => void;
	let localPort = port;
	let localRejectAwaitingMessages = rejectAwaitingMessages;

	return new Promise(function (resolve, reject) {
		localRejectAwaitingMessages.set(messageId, reject);

		localPort.onMessage.addListener(callback = function (response: ResponseMessage) {
			if (response.source === "browser" && response.id === messageId && response.type === "response") {
				console.debug("Response: ", response);
				if (response.status === "OK" && "value" in response) {
					resolve(response.value);
				}
			}
		});

		localPort.postMessage(new Message("browser", messageId, type, value));
		window.setTimeout(reject, 5000);
	})
	.finally(() => {
		localRejectAwaitingMessages.delete(messageId);
		localPort.onMessage.removeListener(callback);
	});
}

export async function changeObserved(observeInfo: ObserveInfo<CommonIdType>): Promise<Arrangement> {
	let newObserveInfo: ObserveInfo<HandleType> = await observedIdMapper.changeObserved(observeInfo,
		async id => (await browser.windowsExt.getNative(id)).handle);
	
	newObserveInfo.deleteFromObserved = newObserveInfo.deleteFromObserved.filter(x => x !== undefined);
	newObserveInfo.addToObserved = newObserveInfo.addToObserved.filter(x => x !== undefined);

	const {arrangement, idsFailedConversion} = Arrangement.fromCustomId(await sendMessage("changeObserved", newObserveInfo), CustomIdName, observedIdMapper.getCommonId.bind(observedIdMapper));
	if (idsFailedConversion.size > 0)
		console.warn(idsFailedConversion);
	
	return arrangement;
}

export async function getArrangement(idArray?: CommonIdType[], inObserved: boolean = true): Promise<Arrangement> {
	let filterHandles = true;
	if (idArray === undefined) {
		filterHandles = false;
	}
	
	let value: { handles: string | HandleType[], inObserved: boolean };
	let localObservedIdMapper: ObservedIdMapper<CommonIdType, HandleType>;

	if (inObserved) {
		localObservedIdMapper = observedIdMapper;

		if (filterHandles) {
			let handleArray: HandleType[] = [];
			for (let id of idArray) {
				let handle: HandleType = localObservedIdMapper.getCustomId(id);
				
				if (handle !== undefined)
					handleArray.push(handle);
			}
			value.handles = handleArray;
		}
		else {
			value.handles = "all";
		}
	}
	else {
		localObservedIdMapper = new ObservedIdMapper<CommonIdType, HandleType>();

		if (filterHandles) {
			const observeInfo = new ObserveInfo<CommonIdType>().add(idArray);

			let newObserveInfo: ObserveInfo<HandleType> = await localObservedIdMapper.changeObserved(observeInfo,
				async id => (await browser.windowsExt.getNative(id)).handle);
			newObserveInfo.addToObserved = newObserveInfo.addToObserved.filter(x => x !== undefined);

			value.handles = newObserveInfo.addToObserved;
		}
		else {
			throw new Error("No idArray provided even though inObserved is false!");
		}
	}

	value.inObserved = inObserved;

	const {arrangement, idsFailedConversion} = Arrangement.fromCustomId(await sendMessage("getArrangement", value), CustomIdName, localObservedIdMapper.getCommonId.bind(localObservedIdMapper));
	if (idsFailedConversion.size > 0)
		console.warn(idsFailedConversion);

	return arrangement;
}

export async function setArrangement(arrangement: Arrangement): Promise<Arrangement> {
	const getCustomId: (commonId: CommonIdType) => HandleType = observedIdMapper.getCustomId.bind(observedIdMapper);
	const {customIdArrangement, idsFailedConversion} = (await arrangement.toCustomId(CustomIdName, getCustomId));
	if (idsFailedConversion.size > 0)
		console.warn(idsFailedConversion);
	
	const responseCustomIdArrangement: CustomIdArrangement<CustomIdName, HandleType> = await sendMessage("setArrangement", customIdArrangement);

	const getCommonId: (customId: HandleType) => CommonIdType = observedIdMapper.getCommonId.bind(observedIdMapper);
	const {arrangement: responseArrangement, idsFailedConversion: responseIdsFailedConversion} = Arrangement.fromCustomId(responseCustomIdArrangement, CustomIdName, getCommonId);
	if (responseIdsFailedConversion.size > 0)
		console.warn(responseIdsFailedConversion);
	
	return responseArrangement;
}

export let onEvent: EventTarget = new EventTarget();

function handleMessageFromApp(message: ResponseMessage) {
	if (message.source === "app") {
		if (message.status === "OK" && message.type === "arrangementChanged") {
			console.debug("From app: ", message);
			const value = Arrangement.fromCustomId(message.value, CustomIdName, observedIdMapper.getCommonId.bind(observedIdMapper));
			const event = new CustomEvent(message.type, { detail: value });
			onEvent.dispatchEvent(event);
		}
		else
			console.warn("Bad status or type of the message from the App!")
	}
}

function handleUnexpectedDisconnection(disconnectedPort: browser.runtime.Port) {
	console.error(`Unexpected disconnection of the App, error: ${disconnectedPort.error}`);

	stopConnection();
	
	const event = new CustomEvent("unexpectedDisconnection", { detail: disconnectedPort.error });
	onEvent.dispatchEvent(event);
}

export function startConnection(): void {
	if (!runningConnection) {
		port = browser.runtime.connectNative(appName);
		port.onDisconnect.addListener(handleUnexpectedDisconnection);
		port.onMessage.addListener(handleMessageFromApp);

		runningConnection = true;
		messageIdCounter = 1;
		observedIdMapper = new ObservedIdMapper();
		rejectAwaitingMessages = new Map();
	}
	else
		console.warn("Connection already running!");
}

export function stopConnection(): void {
	if (runningConnection) {
		runningConnection = false;

		for (let reject of rejectAwaitingMessages.values()) {
			reject();
		}

		port.onDisconnect.removeListener(handleUnexpectedDisconnection);
		port.onMessage.removeListener(handleMessageFromApp);
		port.disconnect();
	}
	else
		console.warn("No running connection!");
}

export function isRunning(): boolean {
	return runningConnection;
}
