
"use strict";

const API_BASE_URL="http://localhost:5000/api";
const USE_MOCK_DATA=true;
const DATA_URL="./equipment-details.json";
const EQUIPMENT_KEY="renthub_added_equipment";
const STEP1_KEY="renthub_add_equipment_draft";
const STEP2_KEY="renthub_add_equipment_step2";
const DRAFT_ID_KEY="renthub_equipment_draft_id";

const $=selector=>document.querySelector(selector);
const params=new URLSearchParams(window.location.search);

const state={
  equipment:null,
  images:[],
  imageIndex:0,
  busy:false,
  lastFocus:null
};

// API SERVICE: BACKEND PLACEHOLDERS
async function apiRequest(endpoint,options={}){
  const token=localStorage.getItem("ownerToken");
  const headers={...options.headers};

  if(token)headers.Authorization=`Bearer ${token}`;
  if(options.body&&!(options.body instanceof FormData)){
    headers["Content-Type"]="application/json";
  }

  let response;

  try{
    response=await fetch(`${API_BASE_URL}${endpoint}`,{
      ...options,
      headers
    });
  }catch{
    throw new Error("Unable to connect to the server.");
  }

  if(!response.ok){
    const error=await response.json().catch(()=>({}));
    throw new Error(error.message||`Request failed: HTTP ${response.status}`);
  }

  if(response.status===204)return null;

  const contentType=response.headers.get("content-type")||"";
  return contentType.includes("application/json")
    ?response.json()
    :null;
}

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

// FETCH EQUIPMENT
async function getEquipment(){
  const requestedId=params.get("id");

  if(USE_MOCK_DATA){
    const items=getSavedEquipment();

    if(requestedId){
      const saved=items.find(item=>String(item.id)===requestedId);
      if(saved)return saved;
    }else if(items.length){
      return items[items.length-1];
    }

    const response=await fetch(DATA_URL,{cache:"no-store"});

    if(!response.ok){
      throw new Error(`Unable to load equipment-details.json (${response.status}).`);
    }

    const data=await response.json();
    const sample=data.equipment;

    if(!sample||typeof sample!=="object"){
      throw new Error("Invalid equipment JSON structure.");
    }

    if(requestedId&&String(sample.id)!==requestedId){
      throw new Error("The requested equipment could not be found.");
    }

    return sample;
  }

  if(!requestedId){
    throw new Error("Equipment ID is missing from the page URL.");
  }

  // BACKEND PLACEHOLDER: GET /api/owner/equipment/:id
  const response=await apiRequest(`/owner/equipment/${encodeURIComponent(requestedId)}`);
  return response?.equipment||response;
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
  element.textContent=message;
  element.className=`mt-3 block text-sm ${isError?"text-red-600":"text-green-700"}`;
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

  return ["./img/camera.png"];
}

function renderGallery(){
  const images=state.images;
  if(!images.length)return;

  state.imageIndex=(state.imageIndex+images.length)%images.length;

  const main=$("#mainEquipmentImage");
  main.src=images[state.imageIndex];
  main.alt=`${state.equipment.name}, photo ${state.imageIndex+1}`;

  $("#imageCounter").textContent=`${state.imageIndex+1} / ${images.length}`;

  const thumbnails=$("#thumbnailList");
  thumbnails.replaceChildren();

  images.forEach((src,index)=>{
    const button=document.createElement("button");
    button.type="button";
    button.className=`overflow-hidden rounded-lg border-2 ${index===state.imageIndex?"border-[#214F79]":"border-transparent"}`;
    button.setAttribute("aria-label",`View equipment photo ${index+1}`);
    button.setAttribute("aria-pressed",String(index===state.imageIndex));

    const image=document.createElement("img");
    image.src=src;
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

// STATUS BADGE
function renderStatus(){
  const item=state.equipment;
  const status=item.status||"Pending Review";
  const badge=$("#equipmentStatus");

  const styles={
    "Published":"bg-[#E9FBF1] text-[#00A965]",
    "Available":"bg-[#E9FBF1] text-[#00A965]",
    "Unavailable":"bg-[#FFE7E5] text-[#D83B31]",
    "Submitted":"bg-[#FFF4DB] text-[#A66B00]",
    "Pending Review":"bg-[#FFF4DB] text-[#A66B00]",
    "Drafts":"bg-[#EDF0F4] text-[#596579]"
  };

  badge.textContent=status;
  badge.className=`shrink-0 rounded-full px-3 py-1.5 text-[14px] font-medium ${styles[status]||"bg-[#EDF0F4] text-[#596579]"}`;

  const button=$("#availabilityButton");
  const unavailable=status==="Unavailable";

  button.textContent=unavailable?"Mark Available":"Mark Unavailable";
  button.disabled=!["Published","Available","Unavailable"].includes(status);
}

// RENDER PAGE
function renderEquipment(){
  const item=state.equipment;

  $("#equipmentName").textContent=item.name||"Unnamed Equipment";
  $("#equipmentLocation").textContent=item.location||"Not specified";
  $("#equipmentPrice").textContent=`${formatMoney(item.price)}/day`;
  $("#availabilityText").textContent=`Available from ${formatDate(item.availableStart)}`;
  $("#equipmentDescription").textContent=item.description||"No description provided";

  const owner=item.owner||{};

  $("#ownerName").textContent=owner.name||"Equipment Owner";
  $("#ownerRating").textContent=owner.rating??"0.0";
  $("#ownerReviews").textContent=`(${owner.reviews??0})`;
  $("#ownerImage").src=owner.image||"./img/profile.svg";

  const details=$("#equipmentDetails");
  details.replaceChildren();

  [
    ["Category",item.category||"Not specified"],
    ["Brand",item.brand||"Not specified"],
    ["Model",item.model||"Not specified"],
    ["Deposit",formatMoney(item.deposit)],
    ["Handover Method",item.handoverMethod||"Not specified"],
    ["Condition",item.condition||"Not specified"]
  ].forEach(([label,value])=>{
    details.appendChild(createDetailRow(label,value));
  });

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
  const container=$("#datesDialogContent");
  container.replaceChildren();

  [
    ["Available from",formatDate(item.availableStart)],
    ["Available until",formatDate(item.availableEnd)],
    ["Unavailable from",item.unavailableStart?formatDate(item.unavailableStart):"None"],
    ["Unavailable until",item.unavailableEnd?formatDate(item.unavailableEnd):"None"]
  ].forEach(([label,value])=>{
    container.appendChild(createDetailRow(label,value));
  });

  openDialog("#datesDialog");
}

// EDIT LISTING
function editListing(){
  const item=state.equipment;
  if(!item)return;

  const step1={
    id:item.id,
    name:item.name,
    equipmentName:item.name,
    category:item.category,
    brand:item.brand,
    model:item.model,
    description:item.description,
    condition:item.condition,
    images:getImages(item),
    owner:item.owner
  };

  const step2={
    location:item.location,
    availableStart:item.availableStart,
    availableEnd:item.availableEnd,
    unavailableStart:item.unavailableStart||"",
    unavailableEnd:item.unavailableEnd||"",
    price:item.price,
    rentalPrice:item.price,
    deposit:item.deposit,
    rentalDeposit:item.deposit,
    handoverMethod:item.handoverMethod
  };

  sessionStorage.setItem(STEP1_KEY,JSON.stringify(step1));
  sessionStorage.setItem(STEP2_KEY,JSON.stringify(step2));
  sessionStorage.setItem(DRAFT_ID_KEY,String(item.id));

  window.location.href="./add-equipment.html?edit=1";
}

// UPDATE EQUIPMENT STATUS
async function updateAvailability(nextStatus){
  if(!state.equipment)throw new Error("Equipment is not loaded.");

  if(USE_MOCK_DATA){
    const updated={...state.equipment,status:nextStatus};
    saveEquipment(updated);
    return updated;
  }

  // BACKEND PLACEHOLDER: PATCH /api/owner/equipment/:id
  const response=await apiRequest(
    `/owner/equipment/${encodeURIComponent(state.equipment.id)}`,
    {
      method:"PATCH",
      body:JSON.stringify({status:nextStatus})
    }
  );

  const updated=response?.equipment||response;

  if(!updated||updated.status!==nextStatus){
    throw new Error("The server did not confirm the availability change.");
  }

  return {...state.equipment,...updated};
}

function askAvailabilityChange(){
  if(state.busy||!state.equipment)return;

  const unavailable=state.equipment.status==="Unavailable";
  const title=unavailable?"Mark Equipment Available?":"Mark Equipment Unavailable?";
  const description=unavailable
    ?"This equipment will be available for new bookings again."
    :"This equipment will no longer be available for new bookings.";

  $("#confirmDialogTitle").textContent=title;
  $("#confirmDialogDescription").textContent=description;
  $("#confirmAvailabilityButton").textContent=unavailable?"Mark Available":"Mark Unavailable";

  openDialog("#confirmDialog");
}

async function confirmAvailabilityChange(){
  if(state.busy)return;

  const nextStatus=state.equipment.status==="Unavailable"?"Published":"Unavailable";
  const button=$("#confirmAvailabilityButton");

  state.busy=true;
  button.disabled=true;
  button.textContent="Updating...";

  try{
    const updated=await updateAvailability(nextStatus);
    state.equipment=updated;

    renderStatus();
    closeDialog("#confirmDialog");

    showMessage(
      nextStatus==="Unavailable"
        ?"Equipment marked unavailable successfully."
        :"Equipment marked available successfully."
    );
  }catch(error){
    console.error("Availability update failed:",error);
    closeDialog("#confirmDialog");
    showMessage(error.message,true);
  }finally{
    state.busy=false;
    button.disabled=false;
  }
}

// SEARCH
function searchEquipment(){
  const query=$("#headerSearch").value.trim();

  if(!query)return;

  window.location.href=`./Equipment.html?search=${encodeURIComponent(query)}`;
}

// LOGOUT
async function logout(){
  if(!USE_MOCK_DATA){
    // BACKEND PLACEHOLDER: POST /api/auth/logout
    await apiRequest("/auth/logout",{method:"POST"});
  }

  localStorage.removeItem("ownerToken");
  window.location.href="../login.html";
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
function initialize(){
  $("#previousImage").addEventListener("click",()=>moveImage(-1));
  $("#nextImage").addEventListener("click",()=>moveImage(1));

  $("#viewDatesButton").addEventListener("click",openDates);
  $("#closeDatesDialog").addEventListener("click",()=>closeDialog("#datesDialog"));

  $("#editListingButton").addEventListener("click",editListing);
  $("#availabilityButton").addEventListener("click",askAvailabilityChange);

  $("#cancelAvailabilityButton").addEventListener("click",()=>closeDialog("#confirmDialog"));
  $("#confirmAvailabilityButton").addEventListener("click",confirmAvailabilityChange);

  $("#retryLoadButton").addEventListener("click",loadPage);

  $("#headerSearch").addEventListener("keydown",event=>{
    if(event.key==="Enter")searchEquipment();
  });

  $("#logoutButton").addEventListener("click",()=>{
    logout().catch(error=>showMessage(error.message,true));
  });

  ["#datesDialog","#confirmDialog"].forEach(selector=>{
    $(selector).addEventListener("click",event=>{
      if(event.target===event.currentTarget)closeDialog(selector);
    });
  });

  document.addEventListener("keydown",event=>{
    if(event.key!=="Escape")return;

    if(!$("#confirmDialog").classList.contains("hidden")){
      closeDialog("#confirmDialog");
    }else if(!$("#datesDialog").classList.contains("hidden")){
      closeDialog("#datesDialog");
    }
  });

  loadPage();
}

document.addEventListener("DOMContentLoaded",initialize);
