
"use strict";

// Owner-only page. This is a UX redirect; the API enforces the owner role on every request.
const AUTH_OK=RentHubAuth.requireLogin(["owner"]);

const USE_MOCK_DATA=false;
const MOCK_FAILURE_TEST=new URLSearchParams(window.location.search).get("simulateFailure")==="1";

const STEP1_KEY="renthub_add_equipment_draft";
const STEP2_KEY="renthub_add_equipment_step2";
const DRAFT_ID_KEY="renthub_equipment_draft_id";
const EQUIPMENT_KEY="renthub_added_equipment";
const FILES_KEY="renthub_add_equipment_files";
const PLACEHOLDER_IMAGE="../img/camera.svg";
const MAX_IMAGES=6;

const $=selector=>document.querySelector(selector);

const state={
  equipment:null,
  images:[],
  imageIndex:0,
  loading:false,
  submitted:false,
  lastFocused:null,
  uploaded:[]
};

// STORAGE HELPERS
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

function saveEquipment(equipment){
  const items=getSavedEquipment();
  const index=items.findIndex(item=>String(item.id)===String(equipment.id));

  if(index>=0)items[index]=equipment;
  else items.push(equipment);

  localStorage.setItem(EQUIPMENT_KEY,JSON.stringify(items));
}

function clearDraft(){
  sessionStorage.removeItem(STEP1_KEY);
  sessionStorage.removeItem(STEP2_KEY);
  sessionStorage.removeItem(DRAFT_ID_KEY);
  sessionStorage.removeItem(FILES_KEY);
  sessionStorage.removeItem("renthub_equipment_created_without_images");
}

function createId(){
  if(window.crypto?.randomUUID)return window.crypto.randomUUID();
  return `equipment-${Date.now()}-${Math.floor(Math.random()*1000000)}`;
}

// MOCK JSON
async function loadSample(){
  const response=await fetch("./listing-preview.json",{cache:"no-store"});

  if(!response.ok){
    throw new Error(`Unable to load listing-preview.json (${response.status}).`);
  }

  const data=await response.json();

  if(!data.equipment||typeof data.equipment!=="object"||Array.isArray(data.equipment)){
    throw new Error("The JSON file must contain an equipment object.");
  }

  return data.equipment;
}

function getStoredFiles(){
  try{return JSON.parse(sessionStorage.getItem(FILES_KEY)||"[]");}catch{return [];}
}

function dataUrlToFile(fileData){
  const parts=String(fileData.dataUrl||"").split(",");
  if(parts.length<2)throw new Error(`Could not read image ${fileData.name||"file"}.`);
  const mime=(parts[0].match(/data:(.*?);base64/)||[])[1]||fileData.type||"image/jpeg";
  const binary=atob(parts[1]);
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return new File([bytes],fileData.name||"equipment-image.jpg",{type:mime});
}

// BUILD LISTING FROM PREVIOUS FORM STEPS
function buildDraft(step1,step2){
  const first=step1.equipment||step1;
  const second=step2.equipment||step2;

  return {
    id:sessionStorage.getItem(DRAFT_ID_KEY)||"local-draft",
    name:first.name||first.equipmentName||"Unnamed Equipment",
    category:first.categoryName||first.category||"Not specified",
    categoryId:first.category||"",
    brand:first.brand||first.brandName||"Not specified",
    model:first.model||"Not specified",
    description:first.description||"No description provided",
    condition:first.condition||"Not specified",
    location:second.location||second.address||"Not specified",
    availableStart:second.availableStart||second.availableFrom||"",
    availableEnd:second.availableEnd||second.availableTo||"",
    unavailableStart:second.unavailableStart||"",
    unavailableEnd:second.unavailableEnd||"",
    price:Number(second.rentalPrice??second.price??0),
    deposit:Number(second.rentalDeposit??second.deposit??0),
    handoverMethod:second.handoverMethod||"Not specified",
    additionalInformation:first.additionalInformation||"",
    rentalRules:second.rentalRules||"",
    images:getStoredFiles().map(file=>file.dataUrl).filter(Boolean),
    owner:first.owner||null,
    status:"Drafts"
  };
}

// FETCH EQUIPMENT
async function getEquipment(){
  const step1=readJSON(sessionStorage,STEP1_KEY);
  const step2=readJSON(sessionStorage,STEP2_KEY);
  if(!step1||!step2){
    throw new Error("Equipment form details are missing. Complete both equipment steps first.");
  }
  return buildDraft(step1,step2);
}

// FORMATTERS
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
    const images=item.images.filter(src=>typeof src==="string"&&src.trim());
    if(images.length)return images;
  }

  if(typeof item.image==="string"&&item.image.trim())return [item.image];

  return [PLACEHOLDER_IMAGE];
}

function renderGallery(){
  const images=state.images;
  if(!images.length)return;

  state.imageIndex=(state.imageIndex+images.length)%images.length;

  $("#mainEquipmentImage").src=RentHubAuth.safeUrl(images[state.imageIndex],{allowData:true})||PLACEHOLDER_IMAGE;
  $("#mainEquipmentImage").alt=`${state.equipment.name}, image ${state.imageIndex+1}`;
  $("#imageCounter").textContent=`${state.imageIndex+1} / ${images.length}`;

  const thumbnails=$("#thumbnailList");
  thumbnails.replaceChildren();

  images.forEach((src,index)=>{
    const button=document.createElement("button");
    button.type="button";
    button.className=`overflow-hidden rounded-lg border-2 ${index===state.imageIndex?"border-[#214F79]":"border-transparent"}`;
    button.setAttribute("aria-label",`View image ${index+1}`);
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

  const multiple=images.length>1;

  ["#previousImage","#nextImage"].forEach(selector=>{
    const button=$(selector);
    button.classList.toggle("hidden",!multiple);
    button.classList.toggle("flex",multiple);
  });
}

function moveImage(direction){
  if(!state.images.length)return;
  state.imageIndex=(state.imageIndex+direction+state.images.length)%state.images.length;
  renderGallery();
}

// DETAILS
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

function renderEquipment(){
  const item=state.equipment;
  state.images=getImages(item);

  $("#equipmentName").textContent=item.name||"Unnamed Equipment";
  $("#equipmentLocation").textContent=item.location||"Not specified";
  $("#equipmentDescription").textContent=item.description||"No description provided";

  const price=`${formatMoney(item.price)}/day`;
  $("#desktopPrice").textContent=price;
  $("#mobilePrice").textContent=price;
  $("#availabilityText").textContent=`Available from ${formatDate(item.availableStart)}`;

  const owner=item.owner||{};
  $("#ownerName").textContent=owner.name||"Equipment Owner";
  $("#ownerRating").textContent=owner.rating??"0.0";
  $("#ownerReviews").textContent=`(${owner.reviews??0})`;
  $("#ownerImage").src=RentHubAuth.safeUrl(owner.image)||"./img/profile.svg";

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
  renderGallery();

  const submitted=["Submitted","Pending Review","Published","Available","Unavailable","In Use"].includes(item.status);
  state.submitted=submitted;

  const button=$("#submitListingButton");
  button.disabled=submitted;
  button.textContent=submitted?"Listing Already Submitted":"Submit Listing";
}

// AVAILABILITY
function openDates(){
  const item=state.equipment;
  const content=$("#datesContent");
  content.replaceChildren();

  [
    ["Available from",formatDate(item.availableStart)],
    ["Available until",formatDate(item.availableEnd)],
    ["Unavailable from",item.unavailableStart?formatDate(item.unavailableStart):"None"],
    ["Unavailable until",item.unavailableEnd?formatDate(item.unavailableEnd):"None"]
  ].forEach(([label,value])=>{
    content.appendChild(createDetailRow(label,value));
  });

  $("#datesDialog").classList.replace("hidden","flex");
  $("#closeDatesDialog").focus();
}

function closeDates(){
  $("#datesDialog").classList.replace("flex","hidden");
  $("#viewDatesButton").focus();
}

// MODAL CONTROLS
function openModal(selector){
  const modal=$(selector);
  state.lastFocused=document.activeElement;
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.body.classList.add("overflow-hidden");

  const closeButton=modal.querySelector('button[aria-label^="Close"]');
  closeButton?.focus();
}

function closeModal(selector){
  const modal=$(selector);
  modal.classList.remove("flex");
  modal.classList.add("hidden");
  document.body.classList.remove("overflow-hidden");
  state.lastFocused?.focus();
}

function closeSuccess(){
  closeModal("#successModal");
}

function closeFailure(){
  closeModal("#failureModal");
}

// MOCK SUBMISSION
async function submitMockListing(){
  if(MOCK_FAILURE_TEST){
    throw new Error("Simulated submission failure for testing.");
  }

  const item=state.equipment;

  const submitted={
    ...item,
    id:item.id==="local-draft"?createId():item.id,
    status:"Submitted",
    image:state.images[0]||PLACEHOLDER_IMAGE,
    images:[...state.images],
    submittedAt:new Date().toISOString()
  };

  saveEquipment(submitted);
  clearDraft();

  return submitted;
}

// REAL BACKEND SUBMISSION
// The API has no fields for brand, model, handover or availability dates, so they are stored as
// "Label: value" lines in specs (max 100 characters each). Additional information and rental rules
// are appended to the description. The owner comes from the login token, never from the request.
function buildSpecs(item){
  const specs=[];
  const add=(label,value)=>{
    const text=String(value||"").trim();
    if(text&&text!=="Not specified")specs.push(`${label}: ${text}`.slice(0,100));
  };

  add("Brand",item.brand);
  add("Model",item.model);
  add("Handover method",item.handoverMethod);
  add("Available from",item.availableStart);
  add("Available until",item.availableEnd);
  add("Unavailable from",item.unavailableStart);
  add("Unavailable until",item.unavailableEnd);

  return specs;
}

function buildDescription(item){
  const parts=[String(item.description||"").trim()];
  const extra=String(item.additionalInformation||"").trim();
  const rules=String(item.rentalRules||"").trim();

  if(extra)parts.push(`Additional information: ${extra}`);
  if(rules)parts.push(`Rental rules: ${rules}`);

  return parts.filter(Boolean).join("\n\n");
}

// Photos are uploaded first (one call each); the listing is created afterwards with the resulting URLs.
// Finished uploads are remembered so "Try again" does not upload them twice.
async function uploadImages(){
  const files=getStoredFiles().slice(0,MAX_IMAGES);
  const button=$("#submitListingButton");

  for(let index=0;index<files.length;index++){
    if(state.uploaded[index])continue;
    button.textContent=`Uploading photo ${index+1} of ${files.length}...`;

    try{
      state.uploaded[index]=await RentHubAuth.uploadEquipmentImage(dataUrlToFile(files[index]));
    }catch(error){
      throw new Error(`Photo ${index+1} could not be uploaded: ${error.message}`);
    }
  }

  return state.uploaded.slice(0,files.length);
}

async function submitBackendListing(){
  const item=state.equipment;
  const category=item.category&&item.category!=="Not specified"?item.category:item.categoryId;
  const payload={
    title:String(item.name||"").trim(),
    description:buildDescription(item),
    price:Number(item.price),
    rentalDeposit:Number(item.deposit||0),
    category:String(category||""),
    condition:item.condition&&item.condition!=="Not specified"?item.condition:"",
    location:item.location&&item.location!=="Not specified"?item.location:"",
    specs:buildSpecs(item)
  };

  if(!payload.category)throw new Error("Select a valid equipment category.");
  if(!payload.title||!payload.description||!payload.location||!Number.isFinite(payload.price)){
    throw new Error("Some required equipment details are missing. Please go back and check the form.");
  }
  if(payload.title.length<3)throw new Error("The equipment name must be at least 3 characters.");
  if(payload.price<=0)throw new Error("The rental price must be greater than zero.");
  if(payload.description.length>2000){
    throw new Error("The description, additional information and rental rules together must be 2000 characters or fewer. Please shorten them.");
  }

  payload.images=await uploadImages();

  const result=await RentHubAuth.api("/equipment",{method:"POST",json:payload});
  const created=result?.equipment;
  const id=created?._id||created?.id;
  if(!id)throw new Error("The API did not return the new equipment ID.");

  const images=Array.isArray(created.images)&&created.images.length?created.images:payload.images;
  const normalized={
    ...item,
    id:String(id),
    price:Number(created.price??item.price??0),
    deposit:Number(created.rentalDeposit??item.deposit??0),
    images,
    image:images[0]||item.image,
    // New listings always start in review; an admin approves them before renters can see them.
    status:"Submitted"
  };
  clearDraft();
  return normalized;
}

// SUBMISSION HANDLER
async function handleSubmit(){
  if(state.loading||state.submitted||!state.equipment)return;

  const button=$("#submitListingButton");
  state.loading=true;
  button.disabled=true;
  button.textContent="Submitting...";
  $("#actionMessage").classList.add("hidden");

  try{
    const submitted=USE_MOCK_DATA
      ?await submitMockListing()
      :await submitBackendListing();

    state.equipment=submitted;
    state.submitted=true;
    button.disabled=true;
    button.textContent="Listing Submitted";

    const viewLink=$("#viewEquipmentButton");
    if(!USE_MOCK_DATA&&viewLink&&submitted.id){
      viewLink.href=`./equipment-details.html?id=${encodeURIComponent(submitted.id)}`;
    }

    openModal("#successModal");
  }catch(error){
    console.error("Equipment submission failed:",error);

    showMessage(error.message||"Unable to submit equipment.",true);

    $("#failureDescription").textContent=
      `Your equipment submission failed. ${error.message||"Check your network connection and try again."}`;

    button.disabled=false;
    button.textContent="Submit Listing";

    openModal("#failureModal");
  }finally{
    state.loading=false;
  }
}

// RETRY
function retrySubmission(){
  closeFailure();
  handleSubmit();
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

// INITIALIZATION
async function initialize(){
  $("#previousImage").addEventListener("click",()=>moveImage(-1));
  $("#nextImage").addEventListener("click",()=>moveImage(1));

  $("#viewDatesButton").addEventListener("click",openDates);
  $("#closeDatesDialog").addEventListener("click",closeDates);

  $("#datesDialog").addEventListener("click",event=>{
    if(event.target===event.currentTarget)closeDates();
  });

  $("#submitListingButton").addEventListener("click",handleSubmit);
  $("#retrySubmissionButton").addEventListener("click",retrySubmission);

  $("#closeSuccessModal").addEventListener("click",closeSuccess);
  $("#closeFailureModal").addEventListener("click",closeFailure);
  $("#backFromFailureButton").addEventListener("click",closeFailure);

  $("#addAnotherButton").addEventListener("click",clearDraft);

  document.addEventListener("keydown",event=>{
    if(event.key==="Escape"){
      if(!$("#failureModal").classList.contains("hidden"))closeFailure();
      else if(!$("#successModal").classList.contains("hidden"))closeSuccess();
      else if(!$("#datesDialog").classList.contains("hidden"))closeDates();
    }
  });

  $("#logoutButton").addEventListener("click",()=>{
    logout().catch(error=>showMessage(error.message,true));
  });

  try{
    state.equipment=await getEquipment();

    if(!state.equipment||typeof state.equipment!=="object"){
      throw new Error("Invalid equipment information.");
    }

    renderEquipment();
  }catch(error){
    console.error("Preview loading failed:",error);
    $("#equipmentName").textContent="Equipment unavailable";
    $("#submitListingButton").disabled=true;
    showMessage(error.message,true);
  }
}

if(AUTH_OK)document.addEventListener("DOMContentLoaded",initialize);
