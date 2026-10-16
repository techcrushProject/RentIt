"use strict";

// Owner-only page. This is a UX redirect; the API only lets the owner of a listing change or delete it.
const AUTH_OK=RentHubAuth.requireLogin(["owner"]);

const USE_MOCK_DATA=false;
const DATA_URL="./equipment-details.json";
const EQUIPMENT_KEY="renthub_added_equipment";
const PLACEHOLDER_IMAGE="../img/camera.svg";
const CONDITIONS=["Brand New","Fairly Used"];

const $=selector=>document.querySelector(selector);
const params=new URLSearchParams(window.location.search);

const state={
  equipment:null,
  images:[],
  imageIndex:0,
  busy:false,
  lastFocus:null,
  pendingAction:"availability",
  categories:[]
};

// STORAGE
function readJSON(storage,key){
  try{
    return JSON.parse(storage.getItem(key)||"null");
  }catch{
    return null;
  }
}

function getSavedEquipment(){
  const items=readJSON(localStorage,EQUIPMENT_KEY);
  return Array.isArray(items)?items:[];
}

function saveEquipment(item){
  const items=getSavedEquipment();
  const index=items.findIndex(saved=>String(saved.id)===String(item.id));

  if(index>=0)items[index]=item;
  else items.push(item);

  localStorage.setItem(EQUIPMENT_KEY,JSON.stringify(items));
}

// BRAND, MODEL, HANDOVER AND AVAILABILITY DATES ARE STORED AS "Label: value" LINES IN specs
function specValue(specs,label){
  const prefix=`${label.toLowerCase()}:`;
  const line=(Array.isArray(specs)?specs:[]).find(spec=>typeof spec==="string"&&spec.toLowerCase().startsWith(prefix));
  return line?line.slice(prefix.length).trim():"";
}

// API status (pending | approved | rejected) plus availability -> label shown in this page.
// `approval` keeps the raw API status for the review notes.
function normalizeEquipment(item,fallbackId){
  const approval=String(item.status||"pending").toLowerCase();
  const rawOwner=item.owner&&typeof item.owner==="object"?item.owner:{};
  const images=Array.isArray(item.images)?item.images.filter(src=>typeof src==="string"&&src.trim()):[];
  const specs=Array.isArray(item.specs)?item.specs:[];

  return {
    ...item,
    id:String(item._id||item.id||fallbackId||""),
    name:item.title||item.name||"",
    category:item.category?.name||item.category||"",
    price:Number(item.price??item.pricePerDay??0),
    deposit:Number(item.rentalDeposit??item.deposit??0),
    brand:specValue(specs,"Brand"),
    model:specValue(specs,"Model"),
    handoverMethod:specValue(specs,"Handover method"),
    availableStart:specValue(specs,"Available from"),
    availableEnd:specValue(specs,"Available until"),
    unavailableStart:specValue(specs,"Unavailable from"),
    unavailableEnd:specValue(specs,"Unavailable until"),
    owner:{...rawOwner,name:rawOwner.businessName||rawOwner.name||""},
    approval,
    rejectionReason:String(item.rejectionReason||""),
    status:approval==="approved"?(item.availability===false?"Unavailable":"Published")
      :approval==="rejected"?"Rejected"
      :"Submitted",
    images,
    image:images[0]||item.image||PLACEHOLDER_IMAGE
  };
}

// FETCH EQUIPMENT
async function getEquipment(){
  const requestedId=params.get("id");
  if(!requestedId)throw new Error("Equipment ID is missing from the page URL.");
  const result=await RentHubAuth.api(`/equipment/${encodeURIComponent(requestedId)}`);
  const item=result?.equipment;
  if(!item||typeof item!=="object")throw new Error("Equipment details were not found.");
  return normalizeEquipment(item,requestedId);
}

// A PATCH response carries the owner as a bare id, so keep the owner we already loaded.
function mergeUpdate(updated){
  const owner=updated.owner&&typeof updated.owner==="object"?updated.owner:state.equipment.owner;
  return normalizeEquipment({...updated,owner},state.equipment.id);
}

// FORMAT HELPERS
function formatMoney(value){
  return new Intl.NumberFormat("en-NG",{
    style:"currency",
    currency:"NGN",
    maximumFractionDigits:0
  }).format(Number(value)||0);
}

function formatDate(value){
  if(!value)return "Not specified";

  const date=/^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ?new Date(`${value}T12:00:00`)
    :new Date(value);

  if(Number.isNaN(date.getTime()))return String(value);

  return date.toLocaleDateString("en-US",{
    month:"short",
    day:"numeric",
    year:"numeric"
  });
}

function showMessage(message,isError=false){
  const element=$("#actionMessage");
  if(!element)return;
  element.textContent=message;
  element.className=`mt-3 block text-center text-sm ${isError?"text-red-600":"text-green-700"}`;
}

// GALLERY
function getImages(item){
  if(Array.isArray(item.images)){
    const valid=item.images.filter(image=>typeof image==="string"&&image.trim());
    if(valid.length)return valid;
  }

  if(typeof item.image==="string"&&item.image.trim()){
    return [item.image];
  }

  return [PLACEHOLDER_IMAGE];
}

function renderGallery(){
  const images=state.images;
  if(!images.length)return;

  state.imageIndex=(state.imageIndex+images.length)%images.length;

  const main=$("#mainEquipmentImage");
  main.src=RentHubAuth.safeUrl(images[state.imageIndex],{allowData:true})||PLACEHOLDER_IMAGE;
  main.alt=`${state.equipment.name}, photo ${state.imageIndex+1}`;

  $("#imageCounter").textContent=`${state.imageIndex+1} / ${images.length}`;

  const thumbnails = $("#thumbnailList") || $("#imageThumbnails");
  if (!thumbnails) return;

  thumbnails.replaceChildren();

  images.forEach((src,index)=>{
    const button=document.createElement("button");
    button.type="button";
    button.className=`overflow-hidden rounded-lg border-2 ${index===state.imageIndex?"border-[#214F79]":"border-transparent"}`;
    button.setAttribute("aria-label",`View equipment photo ${index+1}`);
    button.setAttribute("aria-pressed",String(index===state.imageIndex));

    const image=document.createElement("img");
    image.src=RentHubAuth.safeUrl(src,{allowData:true})||PLACEHOLDER_IMAGE;
    image.alt=`Equipment thumbnail ${index+1}`;
    image.loading="lazy";
    image.className="aspect-[1.35/1] w-full object-cover";

    button.appendChild(image);

    button.addEventListener("click",()=>{
      state.imageIndex=index;
      renderGallery();
    });

    thumbnails.appendChild(button);
  });

  const hasMultiple=images.length>1;

  ["#previousImage","#nextImage"].forEach(selector=>{
    const button=$(selector);
    button.classList.toggle("hidden",!hasMultiple);
    button.classList.toggle("block",hasMultiple);
  });
}

function moveImage(direction){
  if(state.images.length<2)return;
  state.imageIndex=(state.imageIndex+direction+state.images.length)%state.images.length;
  renderGallery();
}

// DETAILS ROW
function createDetailRow(label,value){
  const row=document.createElement("div");
  row.className="flex items-center justify-between gap-4 py-3 text-[15px] lg:py-2.5 lg:text-sm";

  const title=document.createElement("span");
  title.className="text-gray-500";
  title.textContent=label;

  const content=document.createElement("span");
  content.className="max-w-[62%] text-right font-semibold text-[#303030]";
  content.textContent=String(value??"Not specified");

  row.append(title,content);
  return row;
}

// STATUS BADGE AND REVIEW NOTE
function renderStatus(){
  const item=state.equipment;
  const status=item.status||"Submitted";
  const badge=$("#equipmentStatus");

  const styles={
    "Published":"bg-[#E9FBF1] text-[#00A965]",
    "Available":"bg-[#E9FBF1] text-[#00A965]",
    "Unavailable":"bg-[#FFE7E5] text-[#D83B31]",
    "Submitted":"bg-[#FFF4DB] text-[#A66B00]",
    "Pending Review":"bg-[#FFF4DB] text-[#A66B00]",
    "Rejected":"bg-[#FFE7E5] text-[#D83B31]",
    "Drafts":"bg-[#EDF0F4] text-[#596579]"
  };

  badge.textContent=status;
  badge.className=`shrink-0 rounded-full px-3 py-1.5 text-[14px] font-medium ${styles[status]||"bg-[#EDF0F4] text-[#596579]"}`;

  const button=$("#availabilityButton");
  const unavailable=status==="Unavailable";

  button.textContent=unavailable?"Mark Available":"Mark Unavailable";
  button.disabled=!["Published","Available","Unavailable"].includes(status);

  const note=$("#statusNote");
  if(!note)return;

  if(item.approval==="rejected"){
    note.textContent=`Rejected${item.rejectionReason?`: ${item.rejectionReason}`:" by the RentHub review team."}\nEdit the listing and save your changes to send it back for review.`;
    note.className="mt-3 whitespace-pre-line break-words rounded-xl bg-[#FFE7E5] px-4 py-3 text-sm leading-relaxed text-[#D83B31]";
  }else if(item.approval==="pending"){
    note.textContent="This listing is waiting for review. Renters cannot see it until RentHub approves it.";
    note.className="mt-3 rounded-xl bg-[#FFF4DB] px-4 py-3 text-sm leading-relaxed text-[#A66B00]";
  }else{
    note.textContent="";
    note.className="mt-3 hidden rounded-xl px-4 py-3 text-sm leading-relaxed";
  }
}

// RENDER PAGE
function renderEquipment(){
  const item=state.equipment;

  $("#equipmentName").textContent=item.name||"Unnamed Equipment";
  $("#equipmentLocation").textContent=item.location||"Not specified";
  $("#equipmentPrice").textContent=`${formatMoney(item.price)}/day`;
  const availabilityText = $("#availableFrom");
  if (availabilityText) {
    availabilityText.textContent = item.availableStart ? `Available from ${formatDate(item.availableStart)}` : "Availability dates not set";
  }
  $("#equipmentDescription").textContent=item.description||"No description provided";

  const owner=item.owner||{};

  $("#ownerName").textContent=owner.name||"Equipment Owner";
  $("#ownerRating").textContent=`${owner.rating??"0.0"} (${owner.reviews??0})`;

  const ownerAvatar = $("#ownerAvatar");
  if (ownerAvatar) ownerAvatar.src = RentHubAuth.safeUrl(owner.image) || "./img/profile.svg";


  // Render specifications into the IDs that exist in the HTML
  $("#detailCategory").textContent = item.category || "Not specified";
  $("#detailBrand").textContent = item.brand || "Not specified";
  $("#detailModel").textContent = item.model || "Not specified";
  $("#detailDeposit").textContent = formatMoney(item.deposit);
  $("#detailHandover").textContent = item.handoverMethod || "Not specified";
  $("#detailCondition").textContent = item.condition || "Not specified";

  state.images=getImages(item);
  state.imageIndex=0;

  renderGallery();
  renderStatus();

  $("#loadingMessage").classList.add("hidden");
  $("#errorContainer").classList.add("hidden");
  $("#equipmentContent").classList.remove("hidden");
  $("#equipmentContent").classList.add("grid");
}

// DIALOG HELPERS
function openDialog(selector){
  const dialog=$(selector);
  state.lastFocus=document.activeElement;
  dialog.classList.remove("hidden");
  dialog.classList.add("flex");
  document.body.classList.add("overflow-hidden");

  dialog.querySelector("button")?.focus();
}

function closeDialog(selector){
  const dialog=$(selector);
  dialog.classList.remove("flex");
  dialog.classList.add("hidden");
  document.body.classList.remove("overflow-hidden");
  state.lastFocus?.focus();
}

// AVAILABILITY DATES
function openDates(){
  const item=state.equipment;
  const container=$("#datesModalContent");
  container.replaceChildren();

  [
    ["Available from",formatDate(item.availableStart)],
    ["Available until",formatDate(item.availableEnd)],
    ["Unavailable from",item.unavailableStart?formatDate(item.unavailableStart):"None"],
    ["Unavailable until",item.unavailableEnd?formatDate(item.unavailableEnd):"None"]
  ].forEach(([label,value])=>{
    container.appendChild(createDetailRow(label,value));
  });

  openDialog("#datesModal");
}

// EDIT LISTING (PATCH /equipment/:id)
async function loadCategories(){
  if(state.categories.length)return state.categories;

  try{
    const result=await RentHubAuth.api("/categories");
    state.categories=(Array.isArray(result?.categories)?result.categories:[])
      .map(category=>String(category?.name||""))
      .filter(Boolean);
  }catch(error){
    console.warn("Could not load categories:",error);
  }

  return state.categories;
}

function fillSelect(select,values,current,emptyLabel){
  const list=[...values];
  if(current&&!list.includes(current))list.unshift(current);

  select.replaceChildren();

  if(!current){
    const empty=document.createElement("option");
    empty.value="";
    empty.textContent=emptyLabel;
    select.appendChild(empty);
  }

  list.forEach(value=>{
    const option=document.createElement("option");
    option.value=value;
    option.textContent=value;
    select.appendChild(option);
  });

  select.value=current||"";
}

function showEditError(message){
  const element=$("#editError");
  element.textContent=message;
  element.classList.toggle("hidden",!message);
}

async function editListing(event){
  event?.preventDefault();

  const item=state.equipment;
  if(!item||state.busy)return;

  $("#editTitle").value=item.name||"";
  $("#editDescription").value=item.description||"";
  $("#editPrice").value=item.price||"";
  $("#editDeposit").value=item.deposit||0;
  $("#editLocation").value=item.location||"";
  fillSelect($("#editCondition"),CONDITIONS,item.condition||"","Select condition");
  fillSelect($("#editCategory"),[],item.category||"","Select category");

  $("#editModalWarning").textContent=item.approval==="approved"
    ?"This listing is approved. Changing its details sends it back for review, and it stays hidden from renters until RentHub approves it again."
    :item.approval==="rejected"
      ?"Saving changes sends this listing back for review."
      :"This listing is already waiting for review. Your changes will be part of that review.";

  showEditError("");
  openDialog("#editModal");

  const categories=await loadCategories();
  fillSelect($("#editCategory"),categories,$("#editCategory").value||item.category||"","Select category");
}

async function saveEdit(event){
  event.preventDefault();
  if(state.busy||!state.equipment)return;

  const item=state.equipment;
  const depositText=$("#editDeposit").value.trim();
  const values={
    title:$("#editTitle").value.trim(),
    category:$("#editCategory").value,
    description:$("#editDescription").value.trim(),
    price:Number($("#editPrice").value),
    rentalDeposit:depositText===""?0:Number(depositText),
    location:$("#editLocation").value.trim(),
    condition:$("#editCondition").value
  };

  if(values.title.length<3||values.title.length>120)return showEditError("The equipment name must be 3 to 120 characters.");
  if(!Number.isFinite(values.price)||values.price<=0||values.price>1e9)return showEditError("Enter a valid price greater than zero.");
  if(!Number.isFinite(values.rentalDeposit)||values.rentalDeposit<0||values.rentalDeposit>1e9)return showEditError("Enter a valid deposit of zero or more.");
  if(values.description.length>2000)return showEditError("The description must be 2000 characters or fewer.");
  if(values.location.length>120)return showEditError("The location must be 120 characters or fewer.");

  const current={
    title:item.name,
    category:item.category,
    description:item.description||"",
    price:item.price,
    rentalDeposit:item.deposit,
    location:item.location||"",
    condition:item.condition||""
  };
  const changes={};
  Object.keys(values).forEach(key=>{
    if(values[key]!==current[key])changes[key]=values[key];
  });

  if(!Object.keys(changes).length)return showEditError("You have not changed anything.");

  const button=$("#saveEdit");
  state.busy=true;
  button.disabled=true;
  button.textContent="Saving...";
  showEditError("");

  try{
    const response=await RentHubAuth.api(`/equipment/${encodeURIComponent(item.id)}`,{method:"PATCH",json:changes});
    const updated=response?.equipment;
    if(!updated||!(updated._id||updated.id))throw new Error("The server did not confirm the changes.");

    state.equipment=mergeUpdate(updated);
    renderEquipment();
    closeDialog("#editModal");

    showMessage(
      item.approval!=="pending"&&state.equipment.approval==="pending"
        ?"Listing updated. It is back in review and hidden from renters until RentHub approves it again."
        :"Listing updated."
    );
  }catch(error){
    console.error("Listing update failed:",error);
    showEditError(error.message);
  }finally{
    state.busy=false;
    button.disabled=false;
    button.textContent="Save changes";
  }
}

// UPDATE AVAILABILITY (PATCH /equipment/:id) AND DELETE (DELETE /equipment/:id)
async function updateAvailability(makeAvailable){
  if(!state.equipment)throw new Error("Equipment is not loaded.");
  const response=await RentHubAuth.api(
    `/equipment/${encodeURIComponent(state.equipment.id)}`,
    {method:"PATCH",json:{availability:makeAvailable}}
  );
  const updated=response?.equipment;
  if(!updated||!(updated._id||updated.id))throw new Error("The server did not confirm the availability change.");
  return mergeUpdate(updated);
}

function askConfirmation(action,title,description,confirmLabel,danger){
  if(state.busy||!state.equipment)return;

  state.pendingAction=action;

  $("#confirmModalTitle").textContent=title;
  $("#confirmModalMessage").textContent=description;

  const confirm=$("#confirmAvailability");
  confirm.textContent=confirmLabel;
  confirm.classList.toggle("bg-[#D83B31]",danger);
  confirm.classList.toggle("bg-[#224F78]",!danger);

  openDialog("#confirmModal");
}

function askAvailabilityChange(){
  if(!state.equipment)return;

  const unavailable=state.equipment.status==="Unavailable";

  askConfirmation(
    "availability",
    unavailable?"Mark Equipment Available?":"Mark Equipment Unavailable?",
    unavailable
      ?"This equipment will be available for new bookings again."
      :"This equipment will no longer be available for new bookings.",
    unavailable?"Mark Available":"Mark Unavailable",
    false
  );
}

function askDelete(){
  askConfirmation(
    "delete",
    "Delete this listing?",
    "This permanently removes the listing from RentHub. This cannot be undone.",
    "Delete",
    true
  );
}

async function confirmAvailabilityChange(){
  if(state.busy)return;

  const makeAvailable=state.equipment.status==="Unavailable";
  const button=$("#confirmAvailability");

  state.busy=true;
  button.disabled=true;
  button.textContent="Updating...";

  try{
    const updated=await updateAvailability(makeAvailable);
    state.equipment=updated;

    renderStatus();
    closeDialog("#confirmModal");

    showMessage(
      makeAvailable
        ?"Equipment marked available successfully."
        :"Equipment marked unavailable successfully."
    );
  }catch(error){
    console.error("Availability update failed:",error);
    closeDialog("#confirmModal");
    showMessage(error.message,true);
  }finally{
    state.busy=false;
    button.disabled=false;
  }
}

async function confirmDelete(){
  if(state.busy||!state.equipment)return;

  const button=$("#confirmAvailability");

  state.busy=true;
  button.disabled=true;
  button.textContent="Deleting...";

  try{
    await RentHubAuth.api(`/equipment/${encodeURIComponent(state.equipment.id)}`,{method:"DELETE"});
    window.location.href="./Equipment.html";
  }catch(error){
    console.error("Listing delete failed:",error);
    closeDialog("#confirmModal");
    showMessage(error.message,true);
    state.busy=false;
    button.disabled=false;
  }
}

function confirmPendingAction(){
  return state.pendingAction==="delete"?confirmDelete():confirmAvailabilityChange();
}

// SEARCH
function searchEquipment(){
  const query=$("#headerSearch").value.trim();

  if(!query)return;

  window.location.href=`./Equipment.html?search=${encodeURIComponent(query)}`;
}

// LOGOUT
async function logout(){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),4000);

  try{
    await RentHubAuth.api("/auth/logout",{method:"POST",signal:controller.signal});
  }catch{
    // Best effort: the local session is cleared below either way.
  }finally{
    clearTimeout(timer);
    RentHubAuth.clearAuth();
    window.location.href=RENTHUB_CONFIG.LOGIN_URL;
  }
}

// LOAD PAGE
async function loadPage(){
  $("#loadingMessage").classList.remove("hidden");
  $("#errorContainer").classList.add("hidden");
  $("#equipmentContent").classList.add("hidden");
  $("#equipmentContent").classList.remove("grid");

  try{
    state.equipment=await getEquipment();

    if(!state.equipment||typeof state.equipment!=="object"){
      throw new Error("Equipment details were not found.");
    }

    renderEquipment();
  }catch(error){
    console.error("Equipment loading failed:",error);
    $("#loadingMessage").classList.add("hidden");
    $("#errorMessage").textContent=error.message;
    $("#errorContainer").classList.remove("hidden");
  }
}

// INITIALIZATION
function initialize() {
  // Image gallery
  $("#previousImage")?.addEventListener("click", () => moveImage(-1));
  $("#nextImage")?.addEventListener("click", () => moveImage(1));

  // Availability dates dialog
  $("#seeAllDates")?.addEventListener("click", openDates);
  $("#closeDatesModal")?.addEventListener("click", () => closeDialog("#datesModal"));
  $("#doneDatesModal")?.addEventListener("click", () => closeDialog("#datesModal"));

  // Listing actions
  $("#editListingButton")?.addEventListener("click", editListing);
  $("#availabilityButton")?.addEventListener("click", askAvailabilityChange);
  $("#deleteListingButton")?.addEventListener("click", askDelete);

  // Edit dialog
  $("#editForm")?.addEventListener("submit", saveEdit);
  $("#closeEditModal")?.addEventListener("click", () => closeDialog("#editModal"));
  $("#cancelEdit")?.addEventListener("click", () => closeDialog("#editModal"));

  // Confirmation dialog (availability and delete)
  $("#cancelAvailability")?.addEventListener(
    "click",
    () => closeDialog("#confirmModal")
  );
  $("#confirmAvailability")?.addEventListener(
    "click",
    confirmPendingAction
  );

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || state.busy) return;

    ["#editModal", "#confirmModal", "#datesModal"].forEach((selector) => {
      const dialog = $(selector);
      if (dialog && !dialog.classList.contains("hidden")) closeDialog(selector);
    });
  });

  // Logout
  $("#logoutButton")?.addEventListener("click", () => {
    logout().catch(error => showMessage(error.message, true));
  });

  // Retry loading after an error
  $("#retryLoadButton")?.addEventListener("click", loadPage);

  // Load the actual equipment selected in the URL
  loadPage();
}

if(AUTH_OK)document.addEventListener("DOMContentLoaded",initialize);
