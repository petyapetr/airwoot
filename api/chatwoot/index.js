import * as contactModel from "./models/contact.js";
import * as ticketModel from "./models/ticket.js";
import * as operatorModel from "./models/operator.js";
import * as channelModel from "./models/channel.js";
import * as conversationView from "./views/conversation.js";

const handleWebhook = async (payload) => {
	const event = payload.event;
	switch (event) {
		case "contact_created": {
			await initConversation(payload);
			break;
		}
		case "message_updated":
			if (payload.message_type === "outgoing") {
				const lastTicketId = await getLastTicketId(payload);
				try {
					await updateAssignee(payload, lastTicketId);
					await updateSource(payload, lastTicketId);
				} catch (err) {
					console.error(err);
					return;
				}
			}
			break;
		case "conversation_status_changed":
			if (payload.status === "resolved") {
				await resolveTicket(payload);
			} else if (payload.status === "open") {
				await reopenConversation(payload);
			}
			break;
		default:
			throw { message: `Unexpected type of event: ${event}`, statusCode: 501 };
	}
};

async function initConversation(body) {
	const account_id = body.account.id;
	const contact_id = body.id;
	const ids = { account_id, contact_id };

	// find or create contact card in airtable
	const contactRecord = await createContact(body);

	// upd chatwoot contact
	await contactModel.fillContactAttr("airtable", contactRecord.id, true, ids);

	// create ticket in airtable
	const ticket = await createTicket(contactRecord.id, body);

	// send private msg to chatwoot
	const ticketURL = await ticketModel.getTicketUrl(ticket);
	const contactUrl = await contactModel.getContactAttr(ids);
	await conversationView.sendPrivateMessage(contactUrl, ticketURL, ids);
	console.log("Conversation has been initialized. New ticket has been created.");
}

// internal services for handling buisness logic
async function createContact(body) {
	const name = body.name || null;
	const phone = body.phone_number || null;
	const tg = body.additional_attributes.username || null;
	const wa = body.phone_number || null; // TODO check wa hook
	const identifier = body.identifier || null;

	// get a list of contacts
	let contacts = [];
	try {
		contacts = await contactModel.getContacts();
	} catch (err) {
		console.error(err);
	}

	// check if contact does exsist
	let contactRecord = contacts.find(
		(record) =>
			record.phone === phone ||
			record.tg === tg ||
			record.wa === wa ||
			record.identifier === identifier
	);
	// TODO fetch person info from exisisting contact card & fill it in
	// create if it doesn't exsist
	try {
		contactRecord ??= await contactModel.createContact({ name, phone, tg, wa, identifier });
	} catch (err) {
		console.error(err);
	}

	return contactRecord;
}

async function createTicket(contactId, metadata) {
	const date = new Date().toLocaleDateString("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		timeZone: "Asia/Tbilisi",
	});
	const status = "Новая";
	const name = [];
	name.push(contactId);

	const phone = metadata.phone_number || metadata.identifier || metadata.name;

	try {
		const ticket = await ticketModel.createTicket({ date, name, status, phone });
		return ticket;
	} catch (err) {
		console.error(err);
	}
}

async function updateAssignee(body, lastTicketId) {
	/* 	const { currentStatus, lastTicketId } = await getTicketStatus(body);
	if (currentStatus !== "Новая") {
		console.log("Ticket is already in work.");
		return;
	}
	await ticketModel.updateTicketStatus(lastTicketId, "В работе"); */

	const assignee = body.sender.name;
	const assigneeId = await operatorModel.getOperatorId(assignee);
	await ticketModel.updateAssignee(lastTicketId, assigneeId);

	console.log(`Ticket was assigned to an operator (ref id: ${assigneeId}).`);
}

async function updateSource(body, lastTicketId) {
	const exisistingChannel = await ticketModel.getTicketChannel(lastTicketId);
	if (!!exisistingChannel) {
		console.log(`Ticket channel remains unchanged. (ref id: ${exisistingChannel}).`);
		return;
	}

	const source = body.conversation.channel;
	let channelName = undefined;
	switch (source) {
		case "Channel::Telegram":
		case "Channel: : Api":
			channelName = "Telegram";
			break;
		case "Channel::What's Up": //TODO add what's up channel source
		default:
			channelName = null;
	}

	if (!channelName) {
		console.log("Ticket channel name is undefined.");
		return;
	}
	const channelId = await channelModel.getChannelId(channelName);
	await ticketModel.updateChannel(lastTicketId, channelId);
	console.log(`Ticket channel was assigned to a (ref id: ${channelId}).`);
}

// unused due to comments from organisation coordinator due to exsisting airtable automations
async function getTicketStatus(body) {
	const lastTicketId = await getLastTicketId(body);
	const currentStatus = await ticketModel.getTicketStatus(lastTicketId);
	return { currentStatus, lastTicketId };
}

async function getLastTicketId(body) {
	const { contactCard, key } = await contactModel.getContactCard(body);
	const tickets = contactCard.fields[key];
	const lastTicketId = tickets[tickets.length - 1];
	return lastTicketId;
}

async function resolveTicket(body) {
	const lastTicketId = await getLastTicketId(body);
	await ticketModel.updateTicketStatus(lastTicketId, "Закрыта");
	console.log(`Ticket has been resolved (ref id: ${lastTicketId}).`);
}

async function reopenConversation(body) {
	const account_id = body.messages[0].account_id;
	const contact_id = body.id;
	const ids = { account_id, contact_id };

	// create ticket in airtable
	const contactUrl = await contactModel.getContactAttr(ids);
	const contactRecordId = contactUrl.split("/")[6].split("?")[0];
	const ticket = await createTicket(contactRecordId, body.conversation.meta);

	// send private msg to chatwoot
	const ticketURL = await ticketModel.getTicketUrl(ticket);
	await conversationView.sendPrivateMessage(contactUrl, ticketURL, ids);
	console.log(`Conversation has been reopened. New ticket has been created.`);
}

export default handleWebhook;
