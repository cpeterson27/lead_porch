/**
 * Monday CRM Integration Adapter
 *
 * Handles:
 * - Monday → Mongo contact sync
 * - Growth Operator CRM → Monday contact creation
 */

const BaseIntegration = require("./BaseIntegration");


// ======================================
// CLEAN MONDAY TEXT
// ======================================

function cleanName(value = "") {

  return String(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

}

// Monday board items rarely have dedicated first/last-name columns — the
// item's own `name` is the only reliably-present identity field, so it's
// the fallback source when no explicit firstName/lastName column is mapped.
function splitFullName(fullName = "") {
  const parts = cleanName(fullName).split(" ").filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}





class MondayAdapter extends BaseIntegration {


  constructor() {

    super("monday", "Monday CRM");

    this.endpoint =
      "https://api.monday.com/v2";

  }

  getCapabilities() {
    return ["createContact", "updateContact", "archiveContact", "findExistingContact", "syncContacts"];
  }

  getBoardId(credentials) {
    return credentials.boardId || process.env.MONDAY_CONTACTS_BOARD_ID;
  }

  buildColumnValues(credentials, contact) {
    const configured = credentials.columnIds || {};
    const defaults = { email: "lead_email", company: "lead_company" };
    const columns = { ...defaults, ...configured };
    const values = {};
    const missingMappings = [];
    const fields = ["firstName", "lastName", "email", "phone", "company", "title", "industry", "employeeCount", "city", "state", "country", "linkedin", "website", "source", "status", "stage", "providerContactId", "providerRecordId", "notes", "campaign"];
    const valueFor = (field) => {
      if (field === "source") return contact.sourceProvider || contact.sources?.[0] || "";
      if (field === "campaign") return contact.campaignName || "";
      if (field === "status") {
        if (contact.stage) return contact.stage;
        return ["inactive", "archived"].includes(contact.status) ? "Unqualified" : "New Lead";
      }
      return contact[field] ?? "";
    };
    fields.forEach((field) => {
      const value = valueFor(field);
      if (!value) return;
      const columnId = columns[field];
      if (!columnId) { missingMappings.push(field); return; }
      if (field === "email") values[columnId] = { email: value, text: value };
      else if (["linkedin", "website"].includes(field)) values[columnId] = { url: String(value), text: String(value) };
      else values[columnId] = String(value);
    });
    return { values, missingMappings };
  }

  async request(credentials, query) {
    const response = await fetch(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: credentials.apiKey }, body: JSON.stringify({ query }) });
    const data = await response.json();
    if (data.errors) throw new Error(data.errors[0].message);
    return data.data;
  }





  async createContact(credentials, contact) {


    if (!credentials || !credentials.apiKey) {
      throw new Error("Monday API key required");
    }



    const boardId = this.getBoardId(credentials);



    if (!boardId) {
      throw new Error("Monday board ID required");
    }



    const { values: columnValues, missingMappings } = this.buildColumnValues(credentials, contact);



    const mutation = `
      mutation {
        create_item(
          board_id: ${boardId},
          item_name: "${this.escapeValue(
            cleanName(contact.name || "Unknown")
          )}",
          column_values: ${JSON.stringify(
            JSON.stringify(columnValues)
          )}
        ) {
          id
          name
        }
      }
    `;



    const data = await this.request(credentials, mutation);
    return { ...data.create_item, missingMappings };


  }

  async updateContact(credentials, contact) {
    if (!credentials?.apiKey) throw new Error("Monday API key required");
    const boardId = this.getBoardId(credentials);
    if (!boardId || !contact.mondayItemId) throw new Error("Monday board ID and item ID required");
    const { values, missingMappings } = this.buildColumnValues(credentials, contact);
    const mutation = `mutation { change_multiple_column_values(board_id: ${boardId}, item_id: ${contact.mondayItemId}, column_values: ${JSON.stringify(JSON.stringify(values))}) { id } }`;
    const data = await this.request(credentials, mutation);
    return { ...data.change_multiple_column_values, missingMappings };
  }

  async archiveContact(credentials, contact) {
    if (!credentials?.apiKey || !contact.mondayItemId) return null;
    const data = await this.request(credentials, `mutation { archive_item(item_id: ${contact.mondayItemId}) { id } }`);
    return data.archive_item;
  }

  async findExistingContact(credentials, contact) {
    if (!credentials?.apiKey) throw new Error("Monday API key required");
    const boardId = this.getBoardId(credentials);
    if (!boardId) throw new Error("Monday board ID required");
    const configured = { email: "lead_email", company: "lead_company", ...(credentials.columnIds || {}) };
    const query = `query { boards(ids:[${boardId}]) { items_page(limit:500) { items { id name column_values { id text } } } } }`;
    const data = await this.request(credentials, query);
    const items = data.boards?.[0]?.items_page?.items || [];
    const value = (item, columnId) => item.column_values?.find((column) => column.id === columnId)?.text?.trim() || "";
    const candidates = items.filter((item) => {
      const providerContact = contact.providerContactId;
      const providerRecord = contact.providerRecordId;
      if (providerContact && configured.providerContactId && value(item, configured.providerContactId) === String(providerContact)) return true;
      if (providerRecord && configured.providerRecordId && value(item, configured.providerRecordId) === String(providerRecord)) return true;
      if (contact.email && value(item, configured.email).toLowerCase() === contact.email.toLowerCase()) return true;
      if (contact.linkedin && configured.linkedin && value(item, configured.linkedin).replace(/\/$/, "").toLowerCase() === contact.linkedin.replace(/\/$/, "").toLowerCase()) return true;
      if (contact.phone && configured.phone && value(item, configured.phone).replace(/\D/g, "") === String(contact.phone).replace(/\D/g, "")) return true;
      return Boolean(contact.company && cleanName(item.name).toLowerCase() === cleanName(contact.name).toLowerCase() && value(item, configured.company).toLowerCase() === contact.company.toLowerCase());
    });
    return candidates[0] || null;
  }







  async syncContacts(credentials) {


    if (!credentials || !credentials.apiKey) {
      throw new Error("Monday API key required");
    }



    const boardId =
      credentials.boardId ||
      process.env.MONDAY_CONTACTS_BOARD_ID;



    if(!boardId){

      throw new Error(
        "Monday board ID required"
      );

    }




    const query = `
      query {
        boards(ids:[${boardId}]) {
          items_page(limit:500) {
            items {
              id
              name
              column_values {
                id
                text
              }
            }
          }
        }
      }
    `;



    const response =
      await fetch(
        this.endpoint,
        {
          method:"POST",

          headers:{
            "Content-Type":"application/json",
            Authorization:credentials.apiKey,
          },

          body:JSON.stringify({
            query,
          }),

        }
      );



    const data =
      await response.json();



    if(data.errors){

      throw new Error(
        data.errors[0].message
      );

    }



    const items =
      data.data?.boards?.[0]?.items_page?.items || [];



    console.log(
      "MONDAY ITEMS FOUND:",
      items.length
    );



    return this.mapMondayContacts(items, credentials);


  }







  mapMondayContacts(items, credentials = {}){


    if(!Array.isArray(items)){

      return [];

    }



    return items

      .map(item => {


        const columns = {};



        item.column_values?.forEach(col => {

          columns[col.id] =
            col.text || "";

        });



        const configured = credentials.columnIds || {};
        const read = (field, fallbacks = []) => {
          const configuredId = configured[field];
          if (configuredId && columns[configuredId]) return columns[configuredId];
          for (const id of fallbacks) if (columns[id]) return columns[id];
          return "";
        };
        const email = read("email", ["lead_email", "email", "Email", "contact_email"]);



        if(!email){

          return null;

        }




        return {


          name:
            cleanName(
              item.name
            ),



          email:
            email.toLowerCase().trim(),



          company: cleanName(read("company", ["lead_company", "company"])),
          firstName: cleanName(read("firstName")) || splitFullName(item.name).firstName,
          lastName: cleanName(read("lastName")) || splitFullName(item.name).lastName,
          title: cleanName(read("title", ["title", "job_title"])),
          phone: read("phone", ["phone", "lead_phone"]),
          industry: cleanName(read("industry", ["industry"])),
          city: cleanName(read("city", ["city"])),
          state: cleanName(read("state", ["state"])),
          country: cleanName(read("country", ["country"])),
          linkedin: read("linkedin", ["linkedin", "linkedin_url"]),
          website: read("website", ["website"]),
          stage: cleanName(read("stage", ["stage", "lead_stage"])),
          notes: read("notes", ["notes"]),



          externalId:
            item.id,



          source:
            "monday",



          type:
            "lead",



          tags:[
            "monday",
          ],



          status:
            "active",

        };


      })

      .filter(Boolean);


  }







  async validateConnection(credentials){


    if(!credentials?.apiKey){

      return false;

    }



    try{

      const user =
        await this.fetchUserInfo(credentials);


      return !!user;


    }
    catch{

      return false;

    }


  }







  async fetchUserInfo(credentials){


    const query = `
      {
        me {
          id
          name
          email
          account {
            name
          }
        }
      }
    `;



    const response =
      await fetch(
        this.endpoint,
        {

          method:"POST",

          headers:{
            "Content-Type":"application/json",
            Authorization:credentials.apiKey,
          },

          body:JSON.stringify({
            query,
          }),

        }
      );



    const data =
      await response.json();



    if(data.errors){

      throw new Error(
        data.errors[0].message
      );

    }



    return data.data?.me || null;


  }







  escapeValue(value){

    return String(value)
      .replace(/"/g,'\\"');

  }







  getInfo(){

    return {

      name:"Monday CRM",

      provider:"monday",

      version:"2.0.0",

      capabilities:[

        "sync_contacts",
        "create_contacts",
        "prevent_duplicates",

      ],

      status:"active",

      description:
        "Two-way Monday CRM contact synchronization",

    };

  }


}



module.exports =
  MondayAdapter;
