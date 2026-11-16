/**
 * Creates the "Team Offsite RSVP" Google Form used to film the Blurt Forms demo.
 *
 * Run it once from https://script.new: paste this file over the starter code,
 * pick createOffsiteRsvp in the toolbar, press Run, and approve the Forms
 * permission when asked. The log (View › Logs, or the execution log panel)
 * prints the form's edit link and the live link to open in Brave.
 *
 * It covers every question type the extension fills: short answer, an
 * email-validated short answer, multiple choice, date, checkboxes with
 * "Other", dropdown, linear scale and paragraph. Run it again for a fresh
 * copy; each run makes a new form in your Drive.
 */
function createOffsiteRsvp() {
  const form = FormApp.create('Team Offsite RSVP')
    .setDescription(
      'Lake Tahoe · June 12–14\n\n' +
        'Let us know if you can make it so we can sort rooms, food and swag. Takes a minute.'
    )
    .setCollectEmail(false)
    .setProgressBar(false)
    .setConfirmationMessage("Thanks! You're on the list. See you at the lake.");

  form.addTextItem().setTitle('Full name').setRequired(true);

  form
    .addTextItem()
    .setTitle('Work email')
    .setRequired(true)
    .setValidation(FormApp.createTextValidation().requireTextIsEmail().build());

  form
    .addMultipleChoiceItem()
    .setTitle('Will you be joining us?')
    .setChoiceValues(["Yes, I'll be there", 'Maybe, still working it out', "No, I can't make it"])
    .setRequired(true);

  form.addDateItem().setTitle('Arrival date').setHelpText('The offsite runs June 12–14.');

  form
    .addCheckboxItem()
    .setTitle('Any dietary requirements?')
    .setChoiceValues(['None', 'Vegetarian', 'Vegan', 'Gluten-free', 'Dairy-free', 'Nut allergy'])
    .showOtherOption(true);

  form
    .addListItem()
    .setTitle('T-shirt size')
    .setChoiceValues(['XS', 'S', 'M', 'L', 'XL', 'XXL']);

  form
    .addScaleItem()
    .setTitle('How excited are you?')
    .setBounds(1, 5)
    .setLabels('Meh', 'Can’t wait');

  form
    .addParagraphTextItem()
    .setTitle('Tell us a fun fact about yourself')
    .setHelpText("We'll use these for the icebreaker. Two or three is great.");

  // Newer forms start unpublished; the live link only takes answers once published.
  if (typeof form.setPublished === 'function') form.setPublished(true);

  Logger.log('Edit: ' + form.getEditUrl());
  Logger.log('Live: ' + form.getPublishedUrl());
}
